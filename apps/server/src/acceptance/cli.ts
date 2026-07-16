import fs from "node:fs/promises";
import path from "node:path";
import { runStage5Acceptance } from "./stage5Acceptance.js";

const outputPath = path.resolve(process.cwd(), process.argv[2] || "artifacts/evaluation/stage-5-integration.json");
const report = await runStage5Acceptance();

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

console.log(`Stage 5 acceptance report written: ${outputPath}`);
console.log(`Completion: ${report.summary.completionRate}% (${report.summary.passed}/${report.summary.total})`);
if (!report.accepted) process.exitCode = 1;
