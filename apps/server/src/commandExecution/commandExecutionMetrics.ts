import type { CommandExecution, CommandExecutionState } from "./types.js";

export type CommandExecutionMetricSnapshot = {
  command_execution_started_total: number;
  command_execution_finished_total: Record<CommandExecutionState, number>;
  command_execution_wait_timeout_total: number;
  command_execution_ready_latency_ms: { count: number; total: number; max: number };
  command_execution_duration_ms: { count: number; total: number; max: number };
  command_execution_output_truncated_total: number;
  command_execution_active_background: number;
};

function distribution() {
  return { count: 0, total: 0, max: 0 };
}

/** 进程内指标不记录命令或输入内容，避免可观测数据泄漏敏感信息。 */
export class CommandExecutionMetrics {
  private started = 0;
  private readonly finished: Record<CommandExecutionState, number> = { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 };
  private waitTimeouts = 0;
  private readonly readyLatency = distribution();
  private readonly duration = distribution();
  private outputTruncated = 0;

  recordStarted() { this.started += 1; }
  recordWaitTimeout() { this.waitTimeouts += 1; }
  recordReady(execution: CommandExecution) { this.observe(this.readyLatency, Date.parse(execution.readyAt || "") - Date.parse(execution.startedAt)); }
  recordFinished(execution: CommandExecution) {
    this.finished[execution.state] += 1;
    this.observe(this.duration, Date.parse(execution.finishedAt || "") - Date.parse(execution.startedAt));
  }
  recordOutputTruncated() { this.outputTruncated += 1; }

  snapshot(executions: CommandExecution[]): CommandExecutionMetricSnapshot {
    return {
      command_execution_started_total: this.started,
      command_execution_finished_total: { ...this.finished },
      command_execution_wait_timeout_total: this.waitTimeouts,
      command_execution_ready_latency_ms: { ...this.readyLatency },
      command_execution_duration_ms: { ...this.duration },
      command_execution_output_truncated_total: this.outputTruncated,
      command_execution_active_background: executions.filter((item) => item.mode === "background" && (item.state === "queued" || item.state === "running")).length
    };
  }

  private observe(target: { count: number; total: number; max: number }, value: number) {
    if (!Number.isFinite(value) || value < 0) return;
    target.count += 1;
    target.total += value;
    target.max = Math.max(target.max, value);
  }
}
