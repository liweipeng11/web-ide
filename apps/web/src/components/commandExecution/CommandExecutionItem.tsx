import type { CommandExecution } from "../../api";

type Props = {
  execution: CommandExecution;
  now: number;
  active: boolean;
  onOpen: (execution: CommandExecution) => void;
  onStop: (execution: CommandExecution) => void;
  onRemove: (execution: CommandExecution) => void;
};

function durationLabel(execution: CommandExecution, now: number) {
  const end = execution.finishedAt ? Date.parse(execution.finishedAt) : now;
  const seconds = Math.max(0, Math.floor((end - Date.parse(execution.startedAt)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** 展示单条后台任务的关键状态与控制入口。 */
export default function CommandExecutionItem({ execution, now, active, onOpen, onStop, onRemove }: Props) {
  const running = execution.state === "queued" || execution.state === "running";
  const status = execution.readiness === "ready" ? "ready" : execution.state;
  return (
    <article className={`command-execution-item${active ? " active" : ""}`}>
      <button className="command-execution-main" type="button" onClick={() => onOpen(execution)} title={execution.command}>
        <span className="command-execution-command">{execution.command}</span>
        <span className="command-execution-meta"><strong data-state={status}>{status}</strong> · {durationLabel(execution, now)}</span>
        {execution.readyUrl && <span className="command-execution-url">{execution.readyUrl}</span>}
      </button>
      <div className="command-execution-item-actions">
        {running
          ? <button type="button" onClick={() => onStop(execution)}>停止</button>
          : <button type="button" onClick={() => onRemove(execution)}>清理</button>}
      </div>
    </article>
  );
}
