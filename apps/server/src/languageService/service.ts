import { config } from "../config.js";
import { DefaultLanguageServiceGateway } from "./languageServiceGateway.js";

/** 进程级单例统一持有 Language Server，避免路由与 Agent 工具重复启动。 */
export const languageServiceGateway = new DefaultLanguageServiceGateway({ enabled: () => config.featureFlags.lsp });

