import assert from "node:assert/strict";
import test from "node:test";
import { CommandOutputBuffer } from "./commandOutputBuffer.js";

test("输出缓冲按 cursor 增量读取", () => {
  const buffer = new CommandOutputBuffer(20);
  buffer.append("hello");
  assert.deepEqual(buffer.read(0), { cursor: 0, nextCursor: 5, data: "hello", truncated: false });
  buffer.append(" world");
  assert.equal(buffer.read(5).data, " world");
});

test("超过上限后只保留尾部并报告游标缺口", () => {
  const buffer = new CommandOutputBuffer(5);
  buffer.append("12345678");
  assert.equal(buffer.tail(), "45678");
  assert.equal(buffer.outputTruncated, true);
  assert.deepEqual(buffer.read(0), { cursor: 3, nextCursor: 8, data: "45678", truncated: true });
});
