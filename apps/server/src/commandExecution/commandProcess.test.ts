import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { childProcessFactory } from "./commandProcess.js";

test("真实子进程输出和退出码通过统一抽象回传", async () => {
  const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "testCommandProcess.ts");
  const command = `${JSON.stringify(process.execPath)} --import tsx ${JSON.stringify(fixture)} output 3`;
  let stdout = "";

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    childProcessFactory.start(
      { command, cwd: process.cwd(), env: process.env },
      {
        onData(stream, data) {
          if (stream === "stdout") stdout += data;
        },
        onExit: resolve,
        onError: reject
      }
    );
  });

  assert.equal(exitCode, 0);
  assert.match(stdout, /line-0/);
  assert.match(stdout, /line-2/);
});
