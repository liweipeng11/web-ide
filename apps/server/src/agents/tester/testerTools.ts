import { analyzeProject } from "../../projectAnalyzer.js";
import type { RuntimeTool } from "../../runtime/contracts.js";
import { runtimeError } from "../../runtime/errors.js";
import { isPathInScope } from "../../runtime/permissionManager.js";
import { runVerification } from "../../verifier/index.js";
import type { VerificationReport } from "../../verifier/types.js";
import { getWorkspaceRoot } from "../../workspaceStore.js";

export const TESTER_TOOL_NAMES = ["run_verification"] as const;

export type TesterToolDependencies = {
  getWorkspaceRoot: typeof getWorkspaceRoot;
  analyzeProject: typeof analyzeProject;
  runVerification: typeof runVerification;
};

const defaultDependencies: TesterToolDependencies = {
  getWorkspaceRoot,
  analyzeProject,
  runVerification
};

function stringArray(value: unknown, field: string, maxItems = 200) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw runtimeError("INVALID_CONTRACT", `${field} 必须是非空字符串数组。`);
  }
  const normalized = [...new Set(value.map((item) => (item as string).trim().replace(/\\/g, "/").replace(/^\.\//, "")))];
  if (normalized.length > maxItems) throw runtimeError("INVALID_CONTRACT", `${field} 超过数量上限。`);
  return normalized;
}

function assertWorkspacePatterns(patterns: string[], field: string) {
  for (const pattern of patterns) {
    try {
      isPathInScope(pattern, ["**"]);
    } catch {
      throw runtimeError("SCOPE_VIOLATION", `${field} 只能包含工作区相对路径。`, { pattern });
    }
  }
}

/**
 * Tester 只暴露验证能力。测试范围先与项目扫描结果求交集，再交给现有增量验证器，
 * 不把模型提供的路径直接拼接为 Shell 命令。
 */
export function createTesterRuntimeTools(dependencies: TesterToolDependencies = defaultDependencies): RuntimeTool[] {
  return [{
    name: "run_verification",
    description: "根据改动文件和测试范围运行受控的 typecheck、lint、test 与必要 build，并返回结构化报告。",
    effect: "execute",
    inputSchema: {
      type: "object",
      properties: {
        changedFiles: { type: "array", items: { type: "string" } },
        testScope: { type: "array", items: { type: "string" } }
      },
      required: ["changedFiles", "testScope"],
      additionalProperties: false
    },
    async execute(args, context): Promise<VerificationReport> {
      const changedFiles = stringArray(args.changedFiles, "run_verification.changedFiles");
      const testScope = stringArray(args.testScope, "run_verification.testScope");
      assertWorkspacePatterns(changedFiles, "changedFiles");
      assertWorkspacePatterns(testScope, "testScope");

      const blockedChangedFiles = changedFiles.filter((filePath) => !isPathInScope(filePath, context.task.readScope));
      if (blockedChangedFiles.length) {
        throw runtimeError("SCOPE_VIOLATION", "Tester 收到 readScope 之外的改动文件。", { blockedChangedFiles });
      }

      const workspaceRoot = dependencies.getWorkspaceRoot();
      if (!workspaceRoot) throw runtimeError("INVALID_CONTRACT", "运行 Tester 前必须打开工作区。");
      const analysis = await dependencies.analyzeProject(workspaceRoot);
      const matchedTests = analysis.testSystem.testFiles.filter((filePath) =>
        testScope.some((pattern) => isPathInScope(filePath, [pattern]))
      );
      const blockedTests = matchedTests.filter((filePath) => !isPathInScope(filePath, context.task.readScope));
      if (blockedTests.length) {
        throw runtimeError("SCOPE_VIOLATION", "testScope 命中了 readScope 之外的测试文件。", { blockedTests });
      }

      if (!matchedTests.length) {
        return {
          status: "no_commands",
          plannedCommands: [],
          plan: {
            mode: "package_fallback",
            commands: [],
            changedFiles,
            affectedPackages: [],
            relatedTests: [],
            buildRequired: false,
            reasons: ["testScope 未命中项目扫描识别的测试文件"],
            diagnostics: [`testScope 未命中测试文件：${testScope.join("、")}`]
          },
          executions: []
        };
      }

      // 把已扫描且已授权的测试文件作为增量线索，复用 verifier 的安全 focused-test 规划。
      return dependencies.runVerification({
        workspaceRoot,
        changedFiles: [...new Set([...changedFiles, ...matchedTests])],
        confirmed: false
      });
    }
  }];
}

export const testerRuntimeTools = createTesterRuntimeTools();
