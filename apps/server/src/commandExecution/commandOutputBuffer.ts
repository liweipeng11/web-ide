export type OutputBufferSnapshot = {
  cursor: number;
  nextCursor: number;
  data: string;
  truncated: boolean;
};

/** 维护带绝对游标的有界文本缓冲，丢弃旧输出时仍可让调用方识别游标缺口。 */
export class CommandOutputBuffer {
  private value = "";
  private startCursor = 0;
  private endCursor = 0;
  private didTruncate = false;

  constructor(private readonly maxLength = 80_000) {
    if (!Number.isInteger(maxLength) || maxLength <= 0) {
      throw new Error("maxLength must be a positive integer");
    }
  }

  append(data: string) {
    const cursor = this.endCursor;
    if (!data) return { cursor, nextCursor: cursor };

    this.value += data;
    this.endCursor += data.length;
    if (this.value.length > this.maxLength) {
      const removedLength = this.value.length - this.maxLength;
      this.value = this.value.slice(removedLength);
      this.startCursor += removedLength;
      this.didTruncate = true;
    }

    return { cursor, nextCursor: this.endCursor };
  }

  read(cursor = this.startCursor): OutputBufferSnapshot {
    const normalizedCursor = Number.isFinite(cursor) ? Math.max(0, Math.floor(cursor)) : this.startCursor;
    const effectiveCursor = Math.min(this.endCursor, Math.max(this.startCursor, normalizedCursor));
    return {
      cursor: effectiveCursor,
      nextCursor: this.endCursor,
      data: this.value.slice(effectiveCursor - this.startCursor),
      truncated: normalizedCursor < this.startCursor
    };
  }

  tail() {
    return this.value;
  }

  get cursor() {
    return this.endCursor;
  }

  get outputTruncated() {
    return this.didTruncate;
  }
}
