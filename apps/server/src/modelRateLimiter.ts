export type ModelRateLimiterOptions = {
  maxCalls: number;
  windowMs: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

function abortError() {
  const error = new Error("Model request was cancelled while waiting for the rate limit.");
  error.name = "AbortError";
  return error;
}

function abortableSleep(ms: number, signal?: AbortSignal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Process-wide sliding-window limiter for real model Provider requests.
 * Waiting happens inside a FIFO queue so concurrent tasks cannot overbook a slot.
 */
export class ModelRateLimiter {
  private readonly timestamps: number[] = [];
  private queue = Promise.resolve();
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(private readonly options: ModelRateLimiterOptions) {
    if (!Number.isInteger(options.maxCalls) || options.maxCalls < 1) throw new Error("maxCalls must be a positive integer.");
    if (!Number.isInteger(options.windowMs) || options.windowMs < 1) throw new Error("windowMs must be a positive integer.");
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? abortableSleep;
  }

  async acquire(signal?: AbortSignal) {
    let release!: () => void;
    const previous = this.queue;
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;

    try {
      while (true) {
        if (signal?.aborted) throw abortError();
        const now = this.now();
        while (this.timestamps.length && this.timestamps[0]! <= now - this.options.windowMs) this.timestamps.shift();
        if (this.timestamps.length < this.options.maxCalls) {
          this.timestamps.push(now);
          return;
        }
        await this.sleep(Math.max(1, this.timestamps[0]! + this.options.windowMs - now), signal);
      }
    } finally {
      release();
    }
  }
}

