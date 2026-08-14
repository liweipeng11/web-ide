import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { TaskSessionCheckpointer } from "./taskSessionCheckpointer.js";

const State = Annotation.Root({ value: Annotation<number> });

function graph(checkpointer: TaskSessionCheckpointer) {
  return new StateGraph(State)
    .addNode("increment", async (state) => ({ value: state.value + 1 }))
    .addEdge(START, "increment")
    .addEdge("increment", END)
    .compile({ checkpointer });
}

test("文件 checkpointer 在新实例中恢复状态且隔离不同 thread", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "langgraph-checkpointer-"));
  try {
    const first = graph(new TaskSessionCheckpointer(directory));
    const configA = { configurable: { thread_id: "task-a", checkpoint_ns: "" } };
    const configB = { configurable: { thread_id: "task-b", checkpoint_ns: "" } };
    assert.equal((await first.invoke({ value: 1 }, configA)).value, 2);
    assert.equal((await first.invoke({ value: 10 }, configB)).value, 11);

    // 新建 saver 和 graph 模拟服务重启，旧 checkpoint 必须仍可读取。
    const restarted = graph(new TaskSessionCheckpointer(directory));
    assert.equal((await restarted.getState(configA)).values.value, 2);
    assert.equal((await restarted.getState(configB)).values.value, 11);

    const raw = await fs.readFile(path.join(directory, "task-a.json"), "utf8");
    assert.doesNotMatch(raw, /完整源码|system prompt|api[_-]?key/i);
  } finally {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});
