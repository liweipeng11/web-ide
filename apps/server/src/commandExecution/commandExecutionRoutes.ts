import { Router, type RequestHandler } from "express";
import path from "node:path";
import { HttpError } from "../errors.js";
import { evaluateCommandPolicy } from "../commandPolicy.js";
import { resolveCommandCwd } from "../commandRunner.js";
import { checkExistence } from "../existenceChecker/index.js";
import { getWorkspaceRoot } from "../workspaceStore.js";
import { parsePackageScript } from "./commandClassifier.js";
import type { CommandExecutionFilter, CommandExecutionMode, CommandExecutionState } from "./types.js";
import { commandExecutionService, type CommandExecutionService } from "./index.js";

type RouteDependencies = {
  service?: CommandExecutionService;
  onStarted?: (taskSessionId: string | undefined, command: string) => Promise<void>;
};

const modes = new Set<CommandExecutionMode>(["foreground", "background", "auto"]);
const states = new Set<CommandExecutionState>(["queued", "running", "succeeded", "failed", "cancelled"]);

function asyncRoute(handler: RequestHandler): RequestHandler {
  return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);
}

function optionalPositiveNumber(value: unknown, name: string) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new HttpError(400, `${name} must be greater than zero`);
  return value;
}

function routeId(value: string | string[]) {
  return Array.isArray(value) ? value[0] : value;
}

async function verifyPackageScript(command: string, cwd: string) {
  const parsed = parsePackageScript(command);
  const workspaceRoot = getWorkspaceRoot();
  if (!parsed || !workspaceRoot) return;

  const packageDirectory = parsed.directory || path.relative(workspaceRoot, cwd);
  const relativeDirectory = path.isAbsolute(packageDirectory) ? path.relative(workspaceRoot, packageDirectory) : packageDirectory;
  const result = await checkExistence(workspaceRoot, [{
    kind: "script",
    value: parsed.script,
    ...(relativeDirectory ? { fromPath: `${relativeDirectory.replace(/[\\/]+$/, "")}/package.json` } : {})
  }]);
  const check = result.checks[0];
  if (check?.status !== "exists") throw new HttpError(400, `Package script "${parsed.script}" is ${check?.status || "missing"}.`);
}

/** 对外提供结构化命令执行 API，所有状态均来自统一执行内核。 */
export function createCommandExecutionRouter(dependencies: RouteDependencies = {}) {
  const router = Router();
  const service = dependencies.service ?? commandExecutionService;
  const requireExecution = async (id: string) => {
    const execution = await service.get(id);
    if (!execution) throw new HttpError(404, "Command execution not found");
    return execution;
  };

  router.post("/command-executions", asyncRoute(async (request, response) => {
    const command = typeof request.body?.command === "string" ? request.body.command.trim() : "";
    if (!command) throw new HttpError(400, "command is required");

    const policy = evaluateCommandPolicy(command);
    if (policy.level === "blocked") throw new HttpError(403, policy.reason);
    if (policy.level === "confirm" && request.body?.confirmed !== true) throw new HttpError(409, policy.reason);

    const cwd = resolveCommandCwd(typeof request.body?.cwd === "string" ? request.body.cwd : undefined);
    await verifyPackageScript(command, cwd);
    const requestedMode = request.body?.mode;
    if (requestedMode !== undefined && !modes.has(requestedMode)) throw new HttpError(400, "mode must be foreground, background, or auto");
    const readyPattern = request.body?.readyPattern;
    if (readyPattern !== undefined && (typeof readyPattern !== "string" || readyPattern.length > 500)) {
      throw new HttpError(400, "readyPattern must be a string of at most 500 characters");
    }
    if (readyPattern) {
      try {
        new RegExp(readyPattern);
      } catch {
        throw new HttpError(400, "readyPattern must be a valid regular expression");
      }
    }

    const execution = await service.start({
      command,
      cwd,
      chatId: typeof request.body?.chatId === "string" ? request.body.chatId : undefined,
      taskSessionId: typeof request.body?.taskSessionId === "string" ? request.body.taskSessionId : undefined,
      mode: requestedMode,
      executionTimeoutMs: optionalPositiveNumber(request.body?.executionTimeoutMs, "executionTimeoutMs"),
      readyPattern
    });
    await dependencies.onStarted?.(execution.taskSessionId, execution.command);

    const waitTimeoutMs = optionalPositiveNumber(request.body?.waitTimeoutMs, "waitTimeoutMs");
    const result = waitTimeoutMs === undefined
      ? execution
      : await service.waitForState(execution.id, {
          until: execution.mode === "background" ? "ready_or_finished" : "finished",
          timeoutMs: waitTimeoutMs,
          killOnTimeout: request.body?.killOnWaitTimeout === true
        });
    response.status(201).json({ execution: result });
  }));

  router.get("/command-executions", asyncRoute(async (request, response) => {
    const filter: CommandExecutionFilter = {};
    if (typeof request.query.chatId === "string") filter.chatId = request.query.chatId;
    if (typeof request.query.taskSessionId === "string") filter.taskSessionId = request.query.taskSessionId;
    if (typeof request.query.state === "string") {
      if (!states.has(request.query.state as CommandExecutionState)) throw new HttpError(400, "invalid execution state");
      filter.state = request.query.state as CommandExecutionState;
    }
    response.json({ executions: await service.list(filter) });
  }));

  router.get("/command-executions/:id", asyncRoute(async (request, response) => {
    const execution = await requireExecution(routeId(request.params.id));
    response.json({ execution });
  }));

  router.get("/command-executions/:id/output", asyncRoute(async (request, response) => {
    const rawCursor = typeof request.query.cursor === "string" ? Number(request.query.cursor) : 0;
    if (!Number.isSafeInteger(rawCursor) || rawCursor < 0) throw new HttpError(400, "cursor must be a non-negative integer");
    const id = routeId(request.params.id);
    await requireExecution(id);
    response.json({ output: await service.readOutput(id, rawCursor) });
  }));

  router.get("/command-executions/:id/summary", asyncRoute(async (request, response) => {
    const id = routeId(request.params.id);
    await requireExecution(id);
    response.json({ summary: await service.getOutputSummary(id) });
  }));

  router.post("/command-executions/:id/background", asyncRoute(async (request, response) => {
    const id = routeId(request.params.id);
    await requireExecution(id);
    response.json({ execution: await service.moveToBackground(id) });
  }));

  router.post("/command-executions/:id/stop", asyncRoute(async (request, response) => {
    const id = routeId(request.params.id);
    await requireExecution(id);
    response.json({ execution: await service.stop(id) });
  }));

  router.delete("/command-executions/:id", asyncRoute(async (request, response) => {
    const id = routeId(request.params.id);
    const execution = await requireExecution(id);
    if (execution.state === "queued" || execution.state === "running") throw new HttpError(409, "Stop the command execution before removing it");
    await service.remove(id);
    response.status(204).end();
  }));

  return router;
}
