import assert from "node:assert/strict";
import test from "node:test";
import { detectCommandReadiness } from "./commandReadinessDetector.js";

test("显式 readyPattern 优先标记服务就绪", () => {
  assert.deepEqual(detectCommandReadiness("boot complete", { readyPattern: "boot\\s+complete" }), { ready: true, source: "pattern" });
});

test("仅本地 HTTP 地址触发 URL 就绪", () => {
  assert.equal(detectCommandReadiness("Local: http://localhost:5173").readyUrl, "http://localhost:5173");
  assert.equal(detectCommandReadiness("docs https://github.com/example/repo").ready, false);
});

test("可靠启动文案可作为无 URL 服务的辅助信号", () => {
  assert.equal(detectCommandReadiness("Compiled successfully in 850ms").source, "startup_message");
  assert.equal(detectCommandReadiness("building 100%").ready, false);
});

test("无效 readyPattern 会返回清晰错误", () => {
  assert.throws(() => detectCommandReadiness("ready", { readyPattern: "[" }), /valid regular expression/);
});
