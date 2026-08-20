import fs from "node:fs/promises";
import path from "node:path";
import { evaluateRolloutObservation } from "./rolloutObservation.js";
import { parseRolloutObservationDocument } from "./rolloutObservationInput.js";

const [inputArgument, outputArgument] = process.argv.slice(2);

async function main() {
  if (!inputArgument) throw new Error("用法：rolloutObservationCli <input.json> [output.json]");
  const inputPath = path.resolve(process.cwd(), inputArgument);
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(inputPath, "utf8"));
  } catch (error) {
    throw new Error(`无法读取或解析观察输入：${error instanceof Error ? error.message : "unknown error"}`);
  }

  const document = parseRolloutObservationDocument(raw);
  const report = {
    schemaVersion: 1,
    decision: evaluateRolloutObservation(document)
  };
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (outputArgument) {
    const outputPath = path.resolve(process.cwd(), outputArgument);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, output, "utf8");
  }
  process.stdout.write(output);
  process.exitCode = report.decision.action === "promote" ? 0 : report.decision.action === "hold" ? 2 : 3;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "观察输入处理失败");
  process.exitCode = 1;
});
