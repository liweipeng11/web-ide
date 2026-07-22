export * from "./types.js";
export * from "./commandProcess.js";
export * from "./commandOutputBuffer.js";
export * from "./commandExecutionService.js";
export * from "./commandExecutionStore.js";
export * from "./commandReadinessDetector.js";
export * from "./commandOutputSummary.js";

import path from "node:path";
import { config } from "../config.js";
import { CommandExecutionService } from "./commandExecutionService.js";
import { CommandExecutionStore } from "./commandExecutionStore.js";

const commandExecutionStore = new CommandExecutionStore({
  stateFilePath: path.join(config.stateDirectory, "command-executions.json"),
  outputDirectory: path.join(config.stateDirectory, "command-output")
});

// 全部调用方共享同一执行内核和持久化仓库，execution ID 始终对应唯一事实来源。
export const commandExecutionService = new CommandExecutionService({ store: commandExecutionStore });
