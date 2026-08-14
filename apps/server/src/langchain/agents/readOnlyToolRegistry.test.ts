import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeToolDescriptor } from "../../runtime/contracts.js";
import { AgentRuntimeError } from "../../runtime/errors.js";
import { createReadOnlyToolRegistry } from "./readOnlyToolRegistry.js";

const descriptors: RuntimeToolDescriptor[] = [
  { name: "grep", description: "搜索代码", effect: "read", inputSchema: { type: "object" } },
  { name: "inspect_symbols", description: "读取符号", effect: "none", inputSchema: { type: "object" } },
  { name: "writeFile", description: "错误标注的写工具", effect: "read", inputSchema: { type: "object" } },
  { name: "applyPatch", description: "应用补丁", effect: "write", inputSchema: { type: "object" } },
  { name: "runCommand", description: "执行命令", effect: "execute", inputSchema: { type: "object" } }
];

test("只读 Registry 只向模型暴露无副作用工具", () => {
  const registry = createReadOnlyToolRegistry(descriptors, async () => null);
  assert.deepEqual(registry.descriptors.map((item) => item.name), ["grep", "inspect_symbols"]);
  assert.deepEqual(registry.tools.map((item) => item.name), ["grep", "inspect_symbols"]);
  assert.equal(registry.has("writeFile"), false);
});

test("只读 Registry 将合法调用委托 Runtime，并拒绝模型伪造写工具", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const registry = createReadOnlyToolRegistry(descriptors, async (name, args) => {
    calls.push({ name, args });
    return { ok: true };
  });

  assert.deepEqual(await registry.call("grep", { pattern: "StateGraph" }), { ok: true });
  assert.deepEqual(calls, [{ name: "grep", args: { pattern: "StateGraph" } }]);
  await assert.rejects(registry.call("writeFile", { filePath: "src/a.ts" }), (error) => {
    assert.equal(error instanceof AgentRuntimeError && error.code, "PERMISSION_DENIED");
    return true;
  });
  assert.equal(calls.length, 1);
});

test("只读 Registry 拒绝重复工具契约", () => {
  assert.throws(
    () => createReadOnlyToolRegistry([descriptors[0]!, descriptors[0]!], async () => null),
    (error) => error instanceof AgentRuntimeError && error.code === "DUPLICATE_TOOL"
  );
});
