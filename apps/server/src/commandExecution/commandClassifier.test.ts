import assert from "node:assert/strict";
import test from "node:test";
import { classifyCommand } from "./commandClassifier.js";

const cases = [
  ["npm run build", "one_shot", undefined],
  ["npm run serve", "long_running", undefined],
  ["npm --prefix app run serve", "long_running", "app"],
  ["npm --prefix=app run serve", "long_running", "app"],
  ["pnpm --dir apps/web dev", "long_running", "apps/web"],
  ["pnpm --dir=apps/web dev", "long_running", "apps/web"],
  ["pnpm -C apps/web run start", "long_running", "apps/web"],
  ["pnpm -C=apps/web run start", "long_running", "apps/web"],
  ["npx vite", "long_running", undefined]
] as const;

for (const [command, kind, directory] of cases) {
  test(`${command} is classified as ${kind}`, () => {
    const result = classifyCommand(command);

    assert.equal(result.kind, kind);
    assert.equal(result.directory, directory);
  });
}

test("unknown package scripts keep their structured metadata", () => {
  assert.deepEqual(classifyCommand("yarn --cwd app custom-script"), {
    kind: "unknown",
    packageManager: "yarn",
    script: "custom-script",
    directory: "app"
  });
});
