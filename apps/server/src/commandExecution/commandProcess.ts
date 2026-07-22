import { spawn } from "node:child_process";

export type CommandProcessStream = "stdout" | "stderr";

export type CommandProcessListeners = {
  onData: (stream: CommandProcessStream, data: string) => void;
  onExit: (exitCode: number | null, signal?: string) => void;
  onError: (error: Error) => void;
};

export type CommandProcessHandle = {
  pid?: number;
  kill: () => boolean;
};

export type StartCommandProcessOptions = {
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
};

export type CommandProcessFactory = {
  start: (options: StartCommandProcessOptions, listeners: CommandProcessListeners) => CommandProcessHandle;
};

/** 隔离 Node 子进程细节，使执行状态机可以通过可控夹具测试。 */
export const childProcessFactory: CommandProcessFactory = {
  start(options, listeners) {
    const child = spawn(options.command, {
      cwd: options.cwd,
      shell: true,
      env: options.env ?? process.env
    });

    child.stdout?.on("data", (chunk: Buffer) => listeners.onData("stdout", chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => listeners.onData("stderr", chunk.toString("utf8")));
    child.once("error", listeners.onError);
    child.once("exit", (code, signal) => listeners.onExit(code, signal ?? undefined));

    return {
      pid: child.pid,
      kill: () => child.kill()
    };
  }
};
