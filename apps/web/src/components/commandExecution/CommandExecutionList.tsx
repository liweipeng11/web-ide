import { useCallback, useEffect, useState } from "react";
import { fetchCommandExecutions, removeCommandExecution, stopCommandExecution, type CommandExecution } from "../../api";
import CommandExecutionItem from "./CommandExecutionItem";
import "./commandExecution.css";

type Props = {
  activeExecutionId?: string;
  onOpen: (execution: CommandExecution) => void;
};

/** 定时恢复并展示后台任务，刷新页面后仍可继续查看、停止或清理。 */
export default function CommandExecutionList({ activeExecutionId, onOpen }: Props) {
  const [executions, setExecutions] = useState<CommandExecution[]>([]);
  const [now, setNow] = useState(Date.now());

  const refresh = useCallback(async () => {
    const result = await fetchCommandExecutions();
    setExecutions(result.executions
      .filter((execution) => execution.mode === "background")
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt)));
  }, []);

  useEffect(() => {
    void refresh();
    const refreshTimer = window.setInterval(() => void refresh(), 2_000);
    const clockTimer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      window.clearInterval(refreshTimer);
      window.clearInterval(clockTimer);
    };
  }, [refresh]);

  async function handleStop(execution: CommandExecution) {
    await stopCommandExecution(execution.id);
    await refresh();
  }

  async function handleRemove(execution: CommandExecution) {
    await removeCommandExecution(execution.id);
    await refresh();
  }

  if (executions.length === 0) return null;
  return (
    <aside className="command-execution-list" aria-label="后台任务">
      <header><strong>后台任务</strong><span>{executions.length}</span></header>
      <div className="command-execution-items">
        {executions.map((execution) => (
          <CommandExecutionItem
            key={execution.id}
            execution={execution}
            now={now}
            active={execution.id === activeExecutionId}
            onOpen={onOpen}
            onStop={(item) => void handleStop(item)}
            onRemove={(item) => void handleRemove(item)}
          />
        ))}
      </div>
    </aside>
  );
}
