# AI IDE 命令执行系统分阶段改造计划

## 1. 文档信息

- 适用项目：`mini-ai-web-editor`
- 技术栈：React 18、TypeScript、Node.js、Express、WebSocket、node-pty、pnpm workspace
- 文档目标：指导当前命令执行能力从“前端终端等待文本完成标记”改造为“服务端统一管理命令生命周期”的任务型执行系统
- 改造原则：分阶段交付、兼容现有接口、每阶段可独立验证、出现问题可快速回退
- 依赖策略：本计划默认不新增第三方依赖，复用 `node:child_process`、`node-pty`、`ws` 和现有 Node 测试体系

## 2. 背景与问题定义

### 2.1 当前执行链路

当前项目存在两套命令执行链路：

1. 命令建议通过 Web 端 `TerminalPanel` 写入共享 PTY，由前端包装命令、采集输出并等待自定义完成标记。
2. Agent 工具和自动验证通过服务端 `commandRunner` 调用 `child_process.spawn`，独立实现超时、输出截断、长期命令识别和结果持久化。

两套链路造成以下问题：

- 命令完成状态存在两个事实来源，行为容易不一致。
- `npm --prefix clr-vue-app run serve` 等带包管理器参数的命令无法被现有正则识别为长期任务。
- 开发服务器不会主动退出，自定义完成标记无法出现，最终被错误报告为等待超时。
- “进程仍在运行”“服务已经就绪”“IDE 停止等待”“命令执行失败”被压缩进同一个 `status` 字段。
- 前端超时返回 `result: null`，导致命令、输出和失败上下文无法完整持久化。
- URL 检测可能把 Browserslist 提示中的 GitHub URL 误认为开发服务地址。
- `exitCode !== 0` 会把 `exitCode: null` 的运行中任务误判为最近失败命令。
- 页面刷新或 WebSocket 断开后，前端无法恢复正在运行的命令状态。

### 2.2 改造后的核心语义

命令执行需要拆分为三个互不替代的维度：

| 维度 | 示例 | 含义 |
| --- | --- | --- |
| 进程状态 | `queued`、`running`、`succeeded`、`failed`、`cancelled` | 操作系统进程的真实生命周期 |
| 执行模式 | `foreground`、`background`、`auto` | 调用方是否同步等待最终退出 |
| 就绪状态 | `pending`、`ready`、`not_applicable` | 长期服务是否已经可以使用 |

必须遵守以下约束：

- 等待超时不等于进程失败。
- 服务就绪不等于进程结束。
- 只有收到真实退出事件且退出码非零，才能判定为 `failed`。
- 用户主动停止应判定为 `cancelled`，不能伪装成普通失败。
- 终端输出只用于展示和就绪辅助判断，不能作为唯一的进程完成事实来源。

## 3. 总体改造目标

### 3.1 改造目标

1. 建立唯一的服务端命令执行内核。
2. 使用 execution ID 跟踪命令，不再依赖前端自定义文本完成标记。
3. 支持前台命令、后台服务、主动停止、状态查询和输出增量读取。
4. 区分等待超时、执行超时、进程失败和服务就绪。
5. 让 Chat、Agent、自动验证和终端面板使用同一套结构化结果。
6. 保留现有权限策略、工作区路径限制和用户审批流程。
7. 支持刷新恢复、日志持久化、输出截断和自动清理。
8. 使用 feature flag 分阶段切换，降低一次性替换风险。

### 3.2 最终改造结果

改造完成后，执行下面的命令：

```bash
npm --prefix clr-vue-app run serve
```

系统应返回类似结果：

```json
{
  "id": "cmd-123",
  "command": "npm --prefix clr-vue-app run serve",
  "mode": "background",
  "state": "running",
  "readiness": "ready",
  "readyUrl": "http://localhost:8080",
  "exitCode": null,
  "waitTimedOut": false
}
```

此时：

- Chat 中显示“服务已就绪，正在后台运行”。
- Agent 可以继续执行浏览器验证或其他任务。
- TerminalPanel 可以继续查看实时输出。
- 用户可以主动停止任务。
- 页面刷新后仍能查询任务状态。
- 进程最终退出后，同一条 execution 记录更新为最终状态。

## 4. 目标架构

```text
Chat / Agent Tool / 自动验证 / 命令建议
                  │
                  ▼
        CommandExecutionService
          ├─ 权限与 cwd 校验
          ├─ 进程或 PTY 启动
          ├─ stdout/stderr 采集
          ├─ 状态机与超时管理
          ├─ 服务就绪检测
          ├─ 输出与元数据持久化
          └─ 事件广播
             │          │
             │          └─ HTTP：启动、查询、停止、读取输出
             └─ WebSocket：输出增量和状态事件
                              │
                              ▼
                     TerminalPanel / Chat UI
```

### 4.1 建议的数据结构

```ts
export type CommandExecutionState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"

export type CommandExecutionMode = "foreground" | "background" | "auto"

export type CommandReadiness = "pending" | "ready" | "not_applicable"

export type CommandExecution = {
  id: string
  command: string
  cwd: string
  chatId?: string
  taskSessionId?: string
  mode: CommandExecutionMode
  state: CommandExecutionState
  readiness: CommandReadiness
  readyUrl?: string
  detectedUrls: string[]
  exitCode: number | null
  signal?: string
  pid?: number
  waitTimedOut: boolean
  outputTruncated: boolean
  outputCursor: number
  startedAt: string
  readyAt?: string
  finishedAt?: string
  failureReason?: "non_zero_exit" | "execution_timeout" | "spawn_error" | "output_limit"
}
```

### 4.2 建议的服务端接口

```ts
type StartCommandInput = {
  command: string
  cwd?: string
  chatId?: string
  taskSessionId?: string
  mode?: CommandExecutionMode
  waitTimeoutMs?: number
  executionTimeoutMs?: number
  killOnWaitTimeout?: boolean
}

interface CommandExecutionService {
  start(input: StartCommandInput): Promise<CommandExecution>
  waitForState(id: string, options: WaitOptions): Promise<CommandExecution>
  get(id: string): Promise<CommandExecution | null>
  list(filter?: CommandExecutionFilter): Promise<CommandExecution[]>
  readOutput(id: string, cursor?: number): Promise<CommandOutputChunk>
  moveToBackground(id: string): Promise<CommandExecution>
  stop(id: string): Promise<CommandExecution>
}
```

## 5. 分阶段实施计划

---

## 阶段 0：基线固化与当前误报止血

### 5.0.1 改造目标

- 在不改变总体架构的前提下修复当前 `--prefix` 长期命令误判。
- 确保超时时仍返回已采集的结构化结果，而不是 `result: null`。
- 修正本地开发 URL 检测和失败命令判断。
- 为后续重构建立可重复测试基线。

### 5.0.2 预期改造结果

- `npm --prefix app run serve`、`pnpm --dir app dev` 可以被识别为长期命令。
- 只包含 GitHub 文档链接的构建输出不会被标记为开发服务就绪。
- 长期命令等待超时后，返回 `running` 或 `timeout` 快照并保留输出。
- `exitCode: null` 且状态为 `running` 的记录不会进入“最近失败命令”。
- 当前 Agent、自动验证和命令建议功能保持可用。

### 5.0.3 改造任务详细设计

#### 任务 0.1：抽取命令分类器

新增：

- `apps/server/src/commandExecution/commandClassifier.ts`
- `apps/server/src/commandExecution/commandClassifier.test.ts`

设计要求：

- 复用 `agentCommandTools.ts` 已有的包管理器参数解析思路。
- 支持 `npm --prefix`、`pnpm --dir`、`pnpm -C` 和等号形式参数。
- 返回结构化分类结果，不只返回布尔值。

建议输出：

```ts
type CommandClassification = {
  kind: "one_shot" | "long_running" | "unknown"
  packageManager?: "npm" | "pnpm" | "yarn" | "bun"
  script?: string
  directory?: string
}
```

#### 任务 0.2：修正 URL 检测

新增：

- `apps/server/src/commandExecution/commandOutputParser.ts`
- `apps/server/src/commandExecution/commandOutputParser.test.ts`

设计要求：

- `detectUrls()` 收集普通 URL。
- `detectLocalReadyUrl()` 只识别 `localhost`、`127.0.0.1`、`0.0.0.0`、`[::1]` 和明确配置的本地域名。
- `https://github.com/browserslist/update-db` 只能进入普通 URL 集合。
- ANSI 清理、输出截断和摘要生成逐步迁入该模块。

#### 任务 0.3：保留超时快照

修改：

- `apps/web/src/components/TerminalPanel.tsx`
- `apps/web/src/hooks/useCommandCenter.ts`
- `apps/web/src/api.ts`
- `apps/server/src/types.ts`

设计要求：

- 前端等待超时后调用 `onCommandComplete` 时必须携带当前输出快照。
- 错误字段用于描述等待超时，但不能丢失 `CommandResult`。
- `useCommandCenter` 必须保存该结果并写入任务记录。
- 暂时保留原 completion marker，阶段 2 再移除。

#### 任务 0.4：修正失败记录筛选

修改：

- `apps/server/src/commandResults.ts`
- 新增 `apps/server/src/commandResults.test.ts`

筛选规则：

```ts
result.status === "failed" || result.status === "timeout"
```

不得再使用：

```ts
result.exitCode !== 0
```

### 5.0.4 阶段验证脚本

```powershell
# 阶段 0：运行新增的分类、输出解析和结果筛选测试
pnpm --filter @mini-ai-web-editor/server exec tsx --test `
  src/commandExecution/commandClassifier.test.ts `
  src/commandExecution/commandOutputParser.test.ts `
  src/commandResults.test.ts

# 验证服务端和 Web 端类型
pnpm --filter @mini-ai-web-editor/server typecheck
pnpm --filter @mini-ai-web-editor/web typecheck

# 验证现有测试没有回归
pnpm --filter @mini-ai-web-editor/server test
pnpm --filter @mini-ai-web-editor/web build
```

必须包含的测试用例：

```text
npm run build                         → one_shot
npm run serve                         → long_running
npm --prefix app run serve            → long_running
pnpm --dir apps/web dev               → long_running
pnpm -C apps/web run start            → long_running
npx vite                              → long_running
包含 localhost:8080 的输出             → ready URL
只包含 github.com 的输出               → 非 ready URL
state=running, exitCode=null           → 非失败记录
```

### 5.0.5 阶段验收标准

- 所有新增单元测试通过。
- 服务端全量测试、前后端 typecheck 和 Web build 通过。
- 手工执行 `npm --prefix clr-vue-app run serve` 后不再出现 `result: null`。
- 命令运行输出能够进入任务记录。

---

## 阶段 1：建立服务端统一命令执行内核

### 5.1.1 改造目标

- 将命令生命周期的事实来源迁移到服务端。
- 通过 execution ID 管理命令。
- 支持真实进程退出、主动停止、输出增量读取和状态查询。
- 暂不替换所有调用方，通过兼容适配器接入现有 `/api/commands/run`。

### 5.1.2 预期改造结果

- 服务端可以独立启动并跟踪一条命令，不依赖浏览器连接是否持续存在。
- 每条命令拥有稳定 ID 和明确状态。
- 命令真实退出时记录退出码。
- 等待超时后可以保持进程运行。
- 用户能够通过服务端接口终止命令。

### 5.1.3 改造任务详细设计

#### 任务 1.1：创建命令执行领域模块

新增：

- `apps/server/src/commandExecution/types.ts`
- `apps/server/src/commandExecution/commandExecutionService.ts`
- `apps/server/src/commandExecution/commandExecutionService.test.ts`
- `apps/server/src/commandExecution/commandProcess.ts`
- `apps/server/src/commandExecution/commandOutputBuffer.ts`
- `apps/server/src/commandExecution/commandOutputBuffer.test.ts`
- `apps/server/src/commandExecution/index.ts`

职责划分：

- `commandProcess.ts`：封装 `child_process` 或 `node-pty`，只暴露 start、data、exit、kill。
- `commandExecutionService.ts`：维护状态机、超时、就绪、停止和事件。
- `commandOutputBuffer.ts`：维护 cursor、内存上限、摘要尾部和截断标记。
- `types.ts`：领域类型，避免继续把大量命令类型堆进通用 `types.ts`。

#### 任务 1.2：实现严格状态机

允许的状态变化：

```text
queued → running
queued → cancelled
running → succeeded
running → failed
running → cancelled
```

禁止：

```text
succeeded → running
failed → running
cancelled → succeeded
```

就绪状态独立变化：

```text
pending → ready
pending → not_applicable
```

重复 exit、重复 stop、WebSocket 重连不能造成重复完成事件。

#### 任务 1.3：区分等待超时和执行超时

- `waitTimeoutMs`：调用者停止同步等待，默认不杀进程。
- `executionTimeoutMs`：进程允许执行的最长时间，到期后终止并记录 `execution_timeout`。
- `killOnWaitTimeout`：只为兼容特定一次性命令提供，默认 `false`。

#### 任务 1.4：提供内存态查询和事件订阅

服务端内部事件：

```ts
type CommandExecutionEvent =
  | { type: "started"; execution: CommandExecution }
  | { type: "output"; id: string; cursor: number; data: string }
  | { type: "ready"; execution: CommandExecution }
  | { type: "finished"; execution: CommandExecution }
```

先使用进程内事件分发，不新增消息队列。

#### 任务 1.5：改造 `commandRunner` 为兼容适配器

修改：

- `apps/server/src/commandRunner.ts`
- `apps/server/src/agentCommandTools.ts`
- `apps/server/src/verifier/verifier.ts`
- `apps/server/src/autoValidationService.ts`

`runProjectCommand()` 暂时保留原签名，内部调用新服务：

1. 创建 execution。
2. 对普通命令等待最终状态。
3. 对后台命令等待 ready 或 wait timeout。
4. 将 execution 映射为旧 `CommandResult` 返回。

### 5.1.4 测试夹具设计

新增：

- `apps/server/src/commandExecution/fixtures/testCommandProcess.ts`

夹具支持：

```text
exit 0                     立即成功
exit 7                     指定非零退出码
output 10                  输出指定行数
sleep 500                  延迟退出
server 18080               输出 localhost URL 后持续运行
silent-server              无输出持续运行
spam 100000                生成大量输出
```

测试不得启动真实生产服务，不得依赖外部网络。

### 5.1.5 阶段验证脚本

```powershell
# 阶段 1：验证统一执行内核
pnpm --filter @mini-ai-web-editor/server exec tsx --test `
  src/commandExecution/commandExecutionService.test.ts `
  src/commandExecution/commandOutputBuffer.test.ts

# 验证原有 Agent 和验证流程仍可通过兼容适配器运行
pnpm --filter @mini-ai-web-editor/server exec tsx --test `
  src/agentCommandTools.test.ts `
  src/verifier/verifier.test.ts `
  src/autoValidationService.test.ts

pnpm --filter @mini-ai-web-editor/server typecheck
pnpm --filter @mini-ai-web-editor/server test
```

核心断言：

```text
exit 0              → succeeded / exitCode 0
exit 7              → failed / exitCode 7
wait timeout        → running / waitTimedOut true / 进程仍存在
execution timeout   → cancelled 或 failed / failureReason execution_timeout
stop                → cancelled / 只产生一次 finished 事件
spam                → outputTruncated true / 内存不无限增长
```

### 5.1.6 阶段验收标准

- 新执行内核覆盖状态机、超时、停止和输出边界测试。
- Agent 工具和 verifier 无需理解 PTY marker。
- 旧接口行为兼容，现有服务端全量测试通过。
- 浏览器断开不影响服务端命令继续运行。

---

## 阶段 2：接入结构化 API 与 WebSocket 事件

### 5.2.1 改造目标

- 对前端公开 execution API。
- 让 TerminalPanel 从“命令执行者”变为“命令展示与控制器”。
- 移除前端 completion marker 和前端120秒事实判定。
- 支持按 cursor 增量读取输出和断线恢复。

### 5.2.2 预期改造结果

- 命令建议通过服务端创建 execution。
- TerminalPanel 只订阅输出并渲染。
- 页面刷新后可以通过 execution ID 恢复状态和日志。
- WebSocket 丢失消息时可以通过 HTTP cursor 补拉。
- `Command timed out while waiting for terminal completion` 不再存在。

### 5.2.3 改造任务详细设计

#### 任务 2.1：增加 HTTP API

修改：

- `apps/server/src/index.ts`

建议接口：

```http
POST /api/command-executions
GET  /api/command-executions
GET  /api/command-executions/:id
GET  /api/command-executions/:id/output?cursor=0
POST /api/command-executions/:id/background
POST /api/command-executions/:id/stop
```

`POST /api/command-executions` 必须继续执行：

- command policy 校验；
- 用户确认校验；
- cwd 必须位于工作区；
- package script 存在性检查；
- taskSessionId 和 chatId 关联。

#### 任务 2.2：扩展 WebSocket 协议

修改：

- `apps/server/src/terminalServer.ts`

建议服务端消息：

```ts
type CommandServerMessage =
  | { type: "command.started"; execution: CommandExecution }
  | { type: "command.output"; id: string; cursor: number; data: string }
  | { type: "command.ready"; execution: CommandExecution }
  | { type: "command.finished"; execution: CommandExecution }
  | { type: "command.error"; id: string; message: string }
```

建议客户端消息：

```ts
type CommandClientMessage =
  | { type: "command.subscribe"; id: string; cursor: number }
  | { type: "command.stop"; id: string }
  | { type: "command.background"; id: string }
```

手工终端输入协议可以继续保留，但必须与 Agent execution 消息分离。

#### 任务 2.3：增加 Web API 客户端

修改：

- `apps/web/src/api.ts`

新增：

```ts
startCommandExecution()
fetchCommandExecution()
fetchCommandExecutionOutput()
stopCommandExecution()
moveCommandExecutionToBackground()
```

前后端共享语义必须一致，不能继续让 Web 端独立推断 `running`。

#### 任务 2.4：改造 TerminalPanel

修改：

- `apps/web/src/components/TerminalPanel.tsx`

删除：

- `wrapCommandForCompletion()`；
- `__AI_CMD_DONE_` marker；
- `commandTimeoutMs` 完成判断；
- `commandLooksLongRunning()`；
- 前端生成最终 CommandResult 的逻辑。

保留：

- xterm 渲染；
- fit 和 resize；
- 输出展示；
- 手工交互终端能力。

新增：

- 订阅 execution；
- 按 cursor 补拉输出；
- “转入后台”“停止”“重新打开”操作；
- 运行、就绪、退出状态展示。

#### 任务 2.5：改造 Command Center

修改：

- `apps/web/src/hooks/useCommandCenter.ts`
- `apps/web/src/appState.ts`
- `apps/web/src/components/ChatPanel.tsx`
- `apps/web/src/components/chat/AgentStepsPanel.tsx`

设计要求：

- 使用 execution ID 关联 Agent step。
- 后台 ready 时解除页面 loading，但 Agent step 保持 `running`。
- execution 最终退出时更新原 Agent step，避免重复追加互相矛盾的步骤。
- `running` 不能立即映射为 `success`。

### 5.2.4 阶段验证脚本

假设本地服务端地址为 `http://localhost:3001`：

```powershell
$baseUri = "http://localhost:3001"

# 启动一个快速成功命令
$started = Invoke-RestMethod `
  -Method Post `
  -Uri "$baseUri/api/command-executions" `
  -ContentType "application/json" `
  -Body '{"command":"node -e \"console.log(123)\"","mode":"foreground"}'

$executionId = $started.execution.id

# 查询最终状态
$execution = Invoke-RestMethod `
  -Method Get `
  -Uri "$baseUri/api/command-executions/$executionId"

if ($execution.execution.state -ne "succeeded") {
  throw "Expected succeeded, got $($execution.execution.state)"
}

# 按 cursor 读取输出
$output = Invoke-RestMethod `
  -Method Get `
  -Uri "$baseUri/api/command-executions/$executionId/output?cursor=0"

if ($output.data -notmatch "123") {
  throw "Expected command output to contain 123"
}
```

自动化测试：

```powershell
pnpm --filter @mini-ai-web-editor/server exec tsx --test `
  src/commandExecution/commandExecutionRoutes.test.ts `
  src/commandExecution/commandExecutionWebSocket.test.ts

pnpm --filter @mini-ai-web-editor/server typecheck
pnpm --filter @mini-ai-web-editor/web typecheck
pnpm --filter @mini-ai-web-editor/web build
pnpm --filter @mini-ai-web-editor/server test
```

### 5.2.5 阶段验收标准

- 前端源码中不再存在 `__AI_CMD_DONE_`。
- 前端不再通过120秒 timer判定命令是否完成。
- 快速命令、失败命令、后台命令均通过统一 API 启动。
- WebSocket断开重连后，输出可以从上次 cursor 继续读取。
- 页面刷新后能够重新展示仍在运行的 execution。

---

## 阶段 3：后台服务、就绪检测与结果持久化

### 5.3.1 改造目标

- 完成长运行服务的一等支持。
- 建立 readiness、后台任务持久化和日志文件存储。
- 让 Agent 在服务 ready 后继续执行，而不等待服务退出。

### 5.3.2 预期改造结果

- `vite`、Vue CLI、Next.js、webpack watch 等服务可以被转入后台。
- 检测到本地 URL 后状态为 `running + ready`。
- 后台任务输出完整保留，传给模型的内容保持有界。
- 服务端重启后至少能识别之前记录为 `interrupted` 或已失联，不能错误显示仍在运行。
- 用户可以查看、停止和清理后台任务。

### 5.3.3 改造任务详细设计

#### 任务 3.1：实现就绪检测器

新增：

- `apps/server/src/commandExecution/commandReadinessDetector.ts`
- `apps/server/src/commandExecution/commandReadinessDetector.test.ts`

第一版检测规则：

1. 命令显式传入 `readyPattern` 时优先使用。
2. 输出出现本地 HTTP URL 时标记 ready。
3. 常见启动文案可以作为辅助信号，但必须避免只凭百分比进度判断。
4. 未识别到 ready 但进程仍运行时保持 `pending`。

后续可选 HTTP 健康检查，但第一版不因健康检查失败终止进程。

#### 任务 3.2：持久化 execution 元数据

新增：

- `apps/server/src/commandExecution/commandExecutionStore.ts`
- `apps/server/src/commandExecution/commandExecutionStore.test.ts`

建议路径：

```text
.mini-ai/state/web-editor/
├── command-executions.json
└── command-output/
    ├── cmd-123.log
    └── cmd-456.log
```

规则：

- 元数据 JSON 不保存完整大输出。
- 每条命令输出写入独立日志文件。
- JSON 写入沿用项目现有 app state 路径能力。
- 启动时把没有对应活动进程的旧 `running` 记录标记为 `interrupted`；如果不扩展主状态，可通过 `failureReason: server_restart` 表达。
- 每工作区保留最近记录，后台活动任务不能因数量上限被提前删除。

#### 任务 3.3：输出压缩与模型摘要

新增：

- `apps/server/src/commandExecution/commandOutputSummary.ts`
- `apps/server/src/commandExecution/commandOutputSummary.test.ts`

设计要求：

- UI 可以查看完整日志。
- 模型默认接收状态、退出码、ready URL、摘要和最后4,000字符。
- 对重复进度条、ANSI动画和重复相同行进行压缩。
- 失败时优先保留错误附近内容和输出尾部。
- 摘要必须注明是否截断。

#### 任务 3.4：改造 Agent Tool 参数

修改：

- `apps/server/src/agentCommandTools.ts`
- `apps/server/src/agentCommandTools.test.ts`
- `apps/server/src/prompts.ts`
- `apps/server/src/prompts.test.ts`

新增参数：

```json
{
  "mode": "foreground | background | auto",
  "waitTimeoutMs": 15000,
  "executionTimeoutMs": 120000
}
```

工具说明必须告诉模型：

- 测试、lint、typecheck、build使用 `foreground`。
- dev、serve、watch使用 `background`。
- 需要继续访问服务时等待 `ready`，而不是等待进程退出。
- 不确定时使用 `auto`，但不得通过无限延长 timeout 规避后台模式。

#### 任务 3.5：后台任务 UI

建议新增：

- `apps/web/src/components/commandExecution/CommandExecutionList.tsx`
- `apps/web/src/components/commandExecution/CommandExecutionItem.tsx`
- `apps/web/src/components/commandExecution/commandExecution.css`

展示内容：

- 命令和工作目录；
- running、ready、failed、cancelled 状态；
- ready URL；
- 已运行时长；
- 显示终端、停止、清理操作。

### 5.3.4 阶段验证脚本

服务端集成验证：

```powershell
$baseUri = "http://localhost:3001"

# 使用测试夹具启动后台服务，避免依赖真实项目端口
$body = @{
  command = "node apps/server/src/commandExecution/fixtures/testCommandProcess.ts server 18080"
  mode = "background"
  waitTimeoutMs = 10000
} | ConvertTo-Json

$started = Invoke-RestMethod `
  -Method Post `
  -Uri "$baseUri/api/command-executions" `
  -ContentType "application/json" `
  -Body $body

$executionId = $started.execution.id
$deadline = (Get-Date).AddSeconds(15)

do {
  Start-Sleep -Milliseconds 300
  $execution = Invoke-RestMethod `
    -Method Get `
    -Uri "$baseUri/api/command-executions/$executionId"
} while ($execution.execution.readiness -ne "ready" -and (Get-Date) -lt $deadline)

if ($execution.execution.state -ne "running") {
  throw "Expected running, got $($execution.execution.state)"
}

if ($execution.execution.readiness -ne "ready") {
  throw "Expected ready service"
}

if ($execution.execution.readyUrl -notmatch "localhost:18080") {
  throw "Unexpected ready URL: $($execution.execution.readyUrl)"
}

# 主动停止后台服务
$stopped = Invoke-RestMethod `
  -Method Post `
  -Uri "$baseUri/api/command-executions/$executionId/stop"

if ($stopped.execution.state -ne "cancelled") {
  throw "Expected cancelled, got $($stopped.execution.state)"
}
```

自动化验证：

```powershell
pnpm --filter @mini-ai-web-editor/server exec tsx --test `
  src/commandExecution/commandReadinessDetector.test.ts `
  src/commandExecution/commandExecutionStore.test.ts `
  src/commandExecution/commandOutputSummary.test.ts `
  src/agentCommandTools.test.ts

pnpm --filter @mini-ai-web-editor/server typecheck
pnpm --filter @mini-ai-web-editor/web typecheck
pnpm --filter @mini-ai-web-editor/web build
pnpm --filter @mini-ai-web-editor/server test
```

### 5.3.5 阶段验收标准

- 后台服务 ready 后 Agent 可以继续下一步。
- 后台服务不会因为 wait timeout 被自动杀死。
- 普通外部 URL 不会触发 ready。
- 完整日志和模型摘要分开存储。
- 用户停止后状态稳定为 `cancelled`，进程不再占用端口。
- 重启应用后不显示虚假的运行中任务。

---

## 阶段 4：Shell Integration、可靠性与灰度切换

### 5.4.1 改造目标

- 提升不同 shell、交互提示和复杂命令下的可靠性。
- 完成从旧执行链路到新执行链路的灰度切换。
- 增加指标、资源回收和故障诊断能力。

### 5.4.2 预期改造结果

- Windows PowerShell、CMD 和常见 Unix shell 行为有明确测试边界。
- Agent发起的命令带有环境标识，CLI可以禁用动画和交互提示。
- 敏感交互不会进入模型上下文。
- 新执行链路可以通过 feature flag 单独启用和回退。
- 后台终端和日志按策略自动清理。

### 5.4.3 改造任务详细设计

#### 任务 4.1：增加 Agent 命令环境标识

启动命令时注入：

```text
MINI_AI_AGENT=1
CI=1（仅对确认兼容的验证命令）
```

用途：

- CLI关闭进度动画；
- 使用机器友好输出；
- 避免等待交互式确认；
- 与用户手工终端命令区分。

不得对所有命令无条件设置 `CI=1`，因为部分开发服务器在 CI 模式下行为不同。

#### 任务 4.2：Shell能力分级

建议记录：

```ts
type ShellCapability = "rich" | "basic" | "none"
```

- `rich`：支持结构化 command start/end/exit code。
- `basic`：能够启动和获取进程 exit，但无法识别复杂子 shell。
- `none`：只能提供原始 PTY，Agent命令不应依赖该模式。

在 Windows 上优先使用 PowerShell执行 Agent命令，手工终端仍尊重用户选择。

#### 任务 4.3：交互和敏感输入处理

至少识别：

- password；
- passphrase；
- PIN；
- verification code；
- 登录确认提示。

默认策略：

- 暂停 Agent命令并标记 `needs_input`；如果不扩展主状态，则通过独立 `interaction` 字段表达。
- UI提示用户聚焦终端输入。
- 输入内容不进入 Chat、CommandResult 和模型摘要。
- 自动模式下可以取消命令，但不能让模型猜测或重复敏感内容。

#### 任务 4.4：资源与清理策略

- 已结束且未被用户固定的后台终端自动清理。
- execution 元数据按工作区保留最近100条或30天。
- 日志配置单文件上限和工作区总上限。
- 活动任务不参与普通历史淘汰。
- 应用退出时停止由当前应用创建且未声明保留的后台任务。

#### 任务 4.5：Feature Flag和兼容回退

修改：

- `apps/server/src/featureFlags.ts`
- `apps/server/src/featureFlags.test.ts`
- `apps/web/src/api.ts`

建议开关：

```ts
commandExecutionV2: boolean
```

灰度步骤：

1. 默认关闭，新测试环境开启。
2. 命令建议优先切换到 V2。
3. Agent `runCommand` 切换到 V2。
4. 自动验证切换到 V2。
5. 观察一个发布周期后删除旧 marker 和旧执行实现。

#### 任务 4.6：可观测性

新增指标：

```text
command_execution_started_total
command_execution_finished_total{state}
command_execution_wait_timeout_total
command_execution_ready_latency_ms
command_execution_duration_ms
command_execution_output_truncated_total
command_execution_active_background
```

日志必须包含 execution ID，但不得记录敏感输入。

### 5.4.4 阶段验证脚本

```powershell
# 检查旧 marker 已完全删除
$markerMatches = rg -n "__AI_CMD_DONE_|waiting for terminal completion" apps
if ($LASTEXITCODE -eq 0) {
  throw "Legacy terminal completion marker still exists:`n$markerMatches"
}

# 检查前后端构建和测试
pnpm --filter @mini-ai-web-editor/server test
pnpm --filter @mini-ai-web-editor/server typecheck
pnpm --filter @mini-ai-web-editor/web typecheck
pnpm --filter @mini-ai-web-editor/web build

# 运行最终命令执行验收脚本
powershell -ExecutionPolicy Bypass `
  -File scripts/check-command-execution-refactor.ps1
```

最终验收脚本 `scripts/check-command-execution-refactor.ps1` 应覆盖：

```text
1. 成功命令
2. 非零退出命令
3. 等待超时但进程继续运行
4. 执行超时并终止进程
5. 后台服务 ready
6. 后台服务主动停止
7. 大输出截断
8. WebSocket断线后的 cursor 补拉
9. 服务端重启后的 interrupted 修正
10. cwd 越界和 blocked 命令仍被拒绝
11. feature flag 关闭时旧链路可回退
12. feature flag 开启时所有调用方使用 V2
```

### 5.4.5 阶段验收标准

- 新旧执行链路可以通过 feature flag 切换。
- V2开启时不存在 completion marker 依赖。
- 安全策略和审批测试全部通过。
- 活动后台任务、日志体积和超时次数具有可观测指标。
- Windows主支持 shell 的验收脚本通过。

## 6. 最终文件计划

### 6.1 新增服务端文件

```text
apps/server/src/commandExecution/
├── types.ts
├── index.ts
├── commandClassifier.ts
├── commandClassifier.test.ts
├── commandOutputParser.ts
├── commandOutputParser.test.ts
├── commandProcess.ts
├── commandOutputBuffer.ts
├── commandOutputBuffer.test.ts
├── commandExecutionService.ts
├── commandExecutionService.test.ts
├── commandExecutionStore.ts
├── commandExecutionStore.test.ts
├── commandReadinessDetector.ts
├── commandReadinessDetector.test.ts
├── commandOutputSummary.ts
├── commandOutputSummary.test.ts
├── commandExecutionRoutes.test.ts
├── commandExecutionWebSocket.test.ts
└── fixtures/
    └── testCommandProcess.ts
```

### 6.2 新增 Web 文件

```text
apps/web/src/components/commandExecution/
├── CommandExecutionList.tsx
├── CommandExecutionItem.tsx
└── commandExecution.css
```

### 6.3 新增脚本

```text
scripts/check-command-execution-refactor.ps1
```

### 6.4 重点修改文件

```text
apps/server/src/commandRunner.ts
apps/server/src/commandResults.ts
apps/server/src/agentCommandTools.ts
apps/server/src/terminalServer.ts
apps/server/src/index.ts
apps/server/src/prompts.ts
apps/server/src/types.ts
apps/server/src/featureFlags.ts
apps/server/src/verifier/verifier.ts
apps/server/src/autoValidationService.ts
apps/web/src/components/TerminalPanel.tsx
apps/web/src/components/ChatPanel.tsx
apps/web/src/components/chat/AgentStepsPanel.tsx
apps/web/src/hooks/useCommandCenter.ts
apps/web/src/appState.ts
apps/web/src/api.ts
apps/server/package.json
package.json
```

`package.json` 只增加测试和验收命令，不增加依赖版本。

## 7. 最终验证命令设计

阶段全部完成后，建议在根 `package.json` 增加：

```json
{
  "scripts": {
    "verify:command-execution": "powershell -ExecutionPolicy Bypass -File scripts/check-command-execution-refactor.ps1"
  }
}
```

服务端 `package.json` 增加：

```json
{
  "scripts": {
    "test:command-execution": "tsx --test src/commandExecution/*.test.ts"
  }
}
```

完整验证：

```powershell
pnpm --filter @mini-ai-web-editor/server test:command-execution
pnpm --filter @mini-ai-web-editor/server test
pnpm --filter @mini-ai-web-editor/server typecheck
pnpm --filter @mini-ai-web-editor/web typecheck
pnpm --filter @mini-ai-web-editor/web build
pnpm verify:command-execution
```

## 8. 发布与回滚策略

### 8.1 发布顺序

1. 合并阶段 0，立即修复当前误报并建立测试。
2. 合并阶段 1，V2执行内核保持关闭，仅跑测试。
3. 合并阶段 2，在测试环境开启命令建议 V2。
4. 合并阶段 3，开启 Agent和自动验证 V2。
5. 合并阶段 4，默认开启 V2并观察一个发布周期。
6. 指标稳定后删除旧 completion marker 和重复实现。

### 8.2 回滚边界

- 阶段 0 可以独立回滚，不影响 API。
- 阶段 1～3 通过 `commandExecutionV2` 回退旧链路。
- execution 新存储与旧 `command-results.json` 分开，回退时不需要迁移或删除用户历史。
- 在确认 V2稳定前，不修改旧数据格式，不删除旧 API。

### 8.3 禁止的回滚方式

- 不清空 `.mini-ai/state`。
- 不删除用户命令历史。
- 不通过无限增加 timeout 掩盖问题。
- 不在前端重新引入新的文本 marker 作为唯一完成依据。

## 9. 风险清单与缓解措施

| 风险 | 影响 | 缓解措施 |
| --- | --- | --- |
| Windows进程树无法完全停止 | 端口残留、后台进程泄漏 | 使用 node-pty 专用 execution，补充端口释放验收 |
| shell复杂语法行为不同 | 命令执行结果不一致 | 记录 shell能力，Agent优先 PowerShell，增加 shell矩阵测试 |
| 大输出导致内存增长 | 服务端内存压力 | 有界 ring buffer、日志文件、模型摘要截断 |
| WebSocket漏消息 | UI输出不完整 | 每段输出带 cursor，允许 HTTP补拉 |
| 服务端重启丢失内存状态 | UI显示错误的 running | 启动恢复时标记 interrupted，不伪造运行状态 |
| URL误识别 | 把文档链接当成服务就绪 | 普通 URL 与 local ready URL 分离 |
| Agent把 running 当 success | 任务计划提前完成 | Agent step保留 running，ready 与 success 分离 |
| 敏感输入进入模型 | 安全风险 | needs_input、人类输入、禁止写入日志和 Chat |
| 双链路长期共存 | 维护成本增加 | feature flag只保留一个发布周期，明确删除旧链路里程碑 |

## 10. 完成定义

只有满足以下全部条件，命令执行改造才算完成：

- 所有命令调用方使用统一服务端执行内核。
- 前端不存在 completion marker 和前端完成超时判断。
- 一次性命令使用真实 exit code 判定结果。
- 长期服务支持 background、ready、stop 和状态恢复。
- 等待超时不会自动等价为命令失败。
- 输出支持流式展示、cursor 补拉、持久化和模型摘要。
- Agent、任务计划和 Chat能够正确区分 running、ready、success、failed、cancelled。
- 权限、cwd、审批和敏感输入规则没有回归。
- `pnpm verify:command-execution`、全量测试、typecheck 和 Web build全部通过。
- V2默认开启并稳定运行一个发布周期后，旧执行链路已删除。

## 11. 参考实现原则

- VS Code使用 Shell Integration 获取命令开始、结束和退出码，并允许长期命令转入后台；等待超时后可返回已有输出，而不是直接把进程判定失败。
- Claude Code把长期命令作为带 task ID 的后台任务，支持后续读取输出、查询状态和停止。
- Cursor后台环境把开发服务器和 watch任务作为独立终端长期运行，而不是等待它们退出。

参考资料：

- [VS Code：Use tools in chat](https://code.visualstudio.com/docs/chat/chat-tools)
- [VS Code：Terminal Shell Integration](https://code.visualstudio.com/docs/terminal/shell-integration)
- [Claude Code：Background bash commands](https://code.claude.com/docs/en/interactive-mode)
- [Cursor：Agent Terminal](https://docs.cursor.com/en/agent/terminal)
- [Cursor：Background Agents](https://docs.cursor.com/background-agent)
