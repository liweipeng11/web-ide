export * from "./types.js";
export * from "./commandProcess.js";
export * from "./commandOutputBuffer.js";
export * from "./commandExecutionService.js";

import { CommandExecutionService } from "./commandExecutionService.js";

// 全部服务端调用方共享同一实例，确保 execution ID 对应唯一的生命周期事实来源。
export const commandExecutionService = new CommandExecutionService();
