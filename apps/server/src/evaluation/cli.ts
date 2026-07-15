import fs from "node:fs/promises";
import path from "node:path";
import { runEvaluationSuite } from "./runner.js";

const outputPath = path.resolve(process.cwd(), process.argv[2] || "artifacts/evaluation/stage-0-baseline.json");
const report = await runEvaluationSuite();
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`Evaluation report written: ${outputPath}`);
if (report.summary.failed > 0) process.exitCode = 1;

