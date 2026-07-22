import assert from "node:assert/strict";
import test from "node:test";
import { detectLocalReadyUrl, detectUrls, parseCommandOutput, stripAnsi } from "./commandOutputParser.js";

test("detects localhost URL as a ready URL", () => {
  assert.equal(detectLocalReadyUrl("Local: http://localhost:8080/"), "http://localhost:8080/");
  assert.equal(detectLocalReadyUrl("ready at http://[::1]:5173"), "http://[::1]:5173");
});

test("keeps GitHub documentation URL without treating it as ready", () => {
  const output = "Browserslist: update with https://github.com/browserslist/update-db";

  assert.deepEqual(detectUrls(output), ["https://github.com/browserslist/update-db"]);
  assert.equal(detectLocalReadyUrl(output), undefined);
});

test("supports explicitly configured local domains", () => {
  assert.equal(detectLocalReadyUrl("http://dev.local:3000", ["dev.local"]), "http://dev.local:3000");
});

test("cleans ANSI output and preserves a timeout snapshot", () => {
  const result = parseCommandOutput({
    command: "npm run serve",
    exitCode: null,
    stdout: "\u001b[32mstarting server\u001b[0m",
    stderr: "",
    timedOut: true,
    timeoutMs: 120_000,
    longRunning: true
  });

  assert.equal(stripAnsi("\u001b[31merror\u001b[0m"), "error");
  assert.equal(result.status, "timeout");
  assert.equal(result.stdout, "starting server");
  assert.match(result.summary, /starting server/);
});
