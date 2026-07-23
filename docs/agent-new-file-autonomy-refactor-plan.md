# Agent 新文件自主创建与任务完成判定分阶段修复方案

## 1. 文档信息

- 适用项目：`mini-ai-web-editor`
- 技术栈：TypeScript、Node.js、Express、React 18、pnpm workspace
- 测试体系：Node.js Test Runner、`tsx --test`、TypeScript 类型检查、Web 生产构建
- 文档状态：待实施
- 修复对象：Agent 在目标文件不存在时无法自主创建文件，并将未完成编辑任务错误标记为成功的问题
- 基准案例：为没有路由目录的 Vue 2 项目创建 `src/router/index.js`，修改 `src/main.js`，增加 `/createUserId` 路由及 `/` 重定向
- 依赖策略：不新增第三方依赖，复用现有文件工具、补丁系统、工作流、任务会话、测试与观测能力

## 2. 问题摘要

当前 Agent 已具备以下能力：

- `proposePatch` 可以生成待审核补丁；
- `writeFile(createIfMissing=true)` 可以创建新文件；
- 工作流可以授权工作区修改和命令执行；
- Runtime 可以执行搜索、读取、编辑、验证和任务状态持久化。

但新增文件任务会被以下循环阻塞：

```text
用户要求创建 src/router/index.js
  ↓
main.js 将引用 ./router
  ↓
编辑前 checkExistence 检查 ./router
  ↓
文件尚未创建，因此返回 missing
  ↓
references_resolved=false
  ↓
proposePatch、writeFile、replaceInFile 全部被工作流门禁阻止
  ↓
Agent 重复搜索和检查，进入预算收敛
  ↓
最终只输出手工建议，没有修改文件
  ↓
Runtime 仍将任务记录为 success/completed
```

根因不是单一 Prompt 问题，而是以下能力缺口共同导致：

1. 存在性检查无法区分“真正缺失”和“本次计划创建”；
2. import 校验只基于当前磁盘状态，无法验证补丁应用后的文件图；
3. 包解析没有从子包目录向上查找最近的 `node_modules`；
4. 路径别名解析没有覆盖 Vue CLI 等框架默认别名；
5. 工作流使用全局布尔状态阻止所有编辑工具，没有按编辑类型区分；
6. 无进展恢复不能识别不可满足的门禁；
7. Runtime 将模型返回最终文本等同于任务完成；
8. 前端没有区分“完成”“未完成”“被门禁阻塞”等状态。

## 3. 总体修复目标

修复完成后，系统必须满足：

1. “没有找到目标文件”可以成为创建新文件的依据，而不是终止条件；
2. 新增文件、修改文件和删除文件使用不同的安全门禁；
3. 同一补丁内新增文件之间以及新增文件与已有文件之间的引用可以被正确验证；
4. 外部依赖、工作区包、相对路径和框架别名能够得到准确状态；
5. 真正缺失或歧义的引用仍会阻止不安全编辑；
6. 编辑任务没有补丁或文件变更时不能标记为成功；
7. 预算不足时优先完成创建、修改和验证，不再重复无效搜索；
8. 前端和日志能够展示真实停止原因及恢复建议；
9. 原始 Vue 2 路由案例可以自动生成双文件补丁并完成验证。

## 4. 目标状态模型

### 4.1 引用状态

```ts
export type ReferenceResolutionStatus =
  | "existing"
  | "planned_create"
  | "dependency_declared"
  | "dependency_installed"
  | "truly_missing"
  | "ambiguous"
  | "unknown";
```

状态语义：

| 状态 | 是否阻止编辑 | 含义 |
| --- | --- | --- |
| `existing` | 否 | 引用目标已在当前工作区真实存在 |
| `planned_create` | 否 | 引用目标将由本次补丁创建 |
| `dependency_declared` | 视策略而定 | 依赖已声明，但没有确认安装状态 |
| `dependency_installed` | 否 | 依赖已在正确包边界中安装 |
| `truly_missing` | 是 | 当前不存在，也不在本次文件计划中 |
| `ambiguous` | 是 | 存在多个候选，不能安全选择 |
| `unknown` | 视风险而定 | 静态分析无法确认，需要验证或用户决策 |

### 4.2 文件计划

```ts
export type PlannedFileChange = {
  filePath: string;
  changeKind: "create" | "modify" | "delete";
  content?: string;
};

export type PlannedFileGraph = {
  creates: Set<string>;
  modifies: Set<string>;
  deletes: Set<string>;
};
```

### 4.3 Runtime 结束状态

```ts
export type AgentRuntimeStatus =
  | "completed"
  | "awaiting_approval"
  | "incomplete"
  | "blocked"
  | "step_limit_reached"
  | "no_progress";
```

其中：

- `completed`：任务交付条件已经满足；
- `awaiting_approval`：补丁或命令已准备好，等待用户批准；
- `incomplete`：任务尚未完成，但仍存在可执行的恢复动作；
- `blocked`：缺少权限、用户决策或无法自动获得的外部条件；
- `step_limit_reached`：达到模型步骤上限；
- `no_progress`：策略恢复后仍无法获得新进展。

## 5. 实施顺序与依赖关系

```text
阶段 0：基线与回归夹具
  ↓
阶段 1：引用状态、包解析与别名解析
  ↓
阶段 2：补丁后虚拟文件图
  ↓
阶段 3：工作流门禁与编辑工具放行
  ↓
阶段 4：任务完成语义与状态修复
  ↓
阶段 5：无进展恢复、预算与 Prompt 收敛
  ↓
阶段 6：前端展示与可观测性
  ↓
阶段 7：端到端验收与灰度收口
```

每个阶段必须独立通过专项测试后才能进入下一阶段。不得用后续阶段的实现掩盖前一阶段的失败。

---

## 6. 阶段 0：建立失败基线与可重复验收夹具

### 6.1 修复目标

- 将本次真实失败固化为自动化测试；
- 在修改 Runtime 前证明当前实现确实会阻止新增路由文件；
- 为后续每个阶段提供稳定的 Vue 2 项目夹具；
- 建立统一阶段验收脚本入口。

### 6.2 修复详情

新增测试夹具生成器，创建最小 Vue 2 项目：

```text
fixture-root/
└─ clr-vue-app/
   ├─ package.json
   ├─ node_modules/vue-router/package.json
   └─ src/
      ├─ App.vue
      ├─ main.js
      └─ views/createuserid.vue
```

夹具必须满足：

- `package.json` 声明 `vue-router@^3.6.5`；
- `node_modules/vue-router/package.json` 真实存在；
- `src/views/createuserid.vue` 真实存在；
- `src/router` 初始不存在；
- `src/main.js` 初始没有 router import；
- 不依赖网络或真实安装命令。

新增失败基线测试：

1. `checkExistence("./router")` 当前返回 `missing`；
2. `checkExistence("@/views/createuserid.vue")` 当前不能正确解析；
3. 从 `src/router/index.js` 解析 `vue-router` 当前失败；
4. `proposePatch` 被 `references_resolved` 门禁阻止；
5. 编辑任务在零变更情况下仍可能返回 `completed`；
6. 任务会话出现 `filesChanged=[]` 与成功状态并存。

### 6.3 预计新增或修改文件

- 新增 `apps/server/src/testing/vue2RouterFixture.ts`
- 新增 `apps/server/src/acceptance/agentNewFileBaseline.test.ts`
- 新增 `scripts/check-agent-new-file-stage0.ps1`
- 修改 `apps/server/package.json`，增加阶段 0 专项测试命令
- 修改根 `package.json`，增加 `verify:agent-new-file-stage0`

### 6.4 修复结果（阶段完成后）

- 真实故障可以在临时工作区稳定重现；
- 基线测试明确记录当前错误，而不是依赖人工查看日志；
- 后续阶段可以复用同一夹具，避免测试环境差异；
- 阶段 0 不改变生产行为。

### 6.5 验收脚本

计划新增 `scripts/check-agent-new-file-stage0.ps1`：

```powershell
$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot

try {
    & pnpm.cmd --filter "@mini-ai-web-editor/server" exec tsx --test `
        src/acceptance/agentNewFileBaseline.test.ts
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    & pnpm.cmd --filter "@mini-ai-web-editor/server" typecheck
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
```

执行命令：

```powershell
pnpm verify:agent-new-file-stage0
```

### 6.6 验收标准

- 基线测试能够稳定捕获三类误判；
- 测试不访问网络；
- 测试不依赖开发者本机已有 `node_modules`；
- Server 类型检查通过；
- 未修改任何生产逻辑。

---

## 7. 阶段 1：重构引用状态、包解析与路径别名解析

### 7.1 修复目标

- 用结构化状态替代笼统的 `exists/missing/ambiguous`；
- 正确解析子包依赖；
- 正确解析 Vue CLI 的 `@ → src`；
- 为“本次计划创建”状态预留接口，但本阶段暂不放开工作流门禁。

### 7.2 修复详情

#### 任务 1.1：扩展引用检查结果

为每项检查增加：

```ts
type ReferenceResolution = {
  status: ReferenceResolutionStatus;
  blocking: boolean;
  reason: string;
  candidates: ExistenceCandidate[];
  packageRoot?: string;
  resolvedPath?: string;
};
```

兼容策略：

- 旧接口需要的 `exists/missing/ambiguous` 可通过适配器派生；
- 新工作流只消费新状态；
- 不一次性删除旧字段，避免影响其他调用方。

#### 任务 1.2：增加最近包边界解析

从 `fromPath` 所属目录开始向上查找：

1. 最近的 `package.json`；
2. 最近包目录中的 `node_modules/<package>`；
3. 父级工作区的 `node_modules/<package>`；
4. pnpm workspace 根目录中的可解析安装位置。

必须保证：

- 查找不会越出工作区；
- 不扫描被忽略目录中的无关内容；
- 多包中出现同名依赖时优先使用引用文件所属包；
- 已声明但未安装返回 `dependency_declared`，不伪装成完全缺失。

#### 任务 1.3：扩展别名解析

按以下优先级解析：

1. `tsconfig.json` 的 `compilerOptions.paths`；
2. `jsconfig.json` 的 `compilerOptions.paths`；
3. Vue CLI 项目默认 `@ → <packageRoot>/src`；
4. 可静态读取的 `vue.config.js` alias；
5. 可静态读取的 `vite.config.ts/js` alias；
6. 无法静态确认时返回 `unknown`。

不得执行不受信任的配置文件代码。只允许安全的静态结构提取；复杂动态配置交给后续构建验证。

### 7.3 预计新增或修改文件

- 修改 `apps/server/src/existenceChecker/types.ts`
- 修改 `apps/server/src/existenceChecker/existenceChecker.ts`
- 修改 `apps/server/src/existenceChecker/index.ts`
- 新增 `apps/server/src/existenceChecker/packageResolver.ts`
- 新增 `apps/server/src/existenceChecker/packageResolver.test.ts`
- 新增 `apps/server/src/existenceChecker/aliasResolver.ts`
- 新增 `apps/server/src/existenceChecker/aliasResolver.test.ts`
- 修改 `apps/server/src/existenceChecker/existenceChecker.test.ts`
- 新增 `scripts/check-agent-new-file-stage1.ps1`

### 7.4 修复结果（阶段完成后）

基准案例应得到：

```text
vue-router               → dependency_installed
@/views/createuserid.vue → existing
./router                 → truly_missing
```

其中 `./router` 仍然缺失是正确结果，因为本阶段尚未引入补丁文件计划。

### 7.5 验收脚本

```powershell
$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot

try {
    & pnpm.cmd --filter "@mini-ai-web-editor/server" exec tsx --test `
        src/existenceChecker/existenceChecker.test.ts `
        src/existenceChecker/packageResolver.test.ts `
        src/existenceChecker/aliasResolver.test.ts
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    & pnpm.cmd --filter "@mini-ai-web-editor/server" typecheck
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
```

执行命令：

```powershell
pnpm verify:agent-new-file-stage1
```

### 7.6 必测场景

```text
子包已声明且已安装依赖              → dependency_installed
子包已声明但没有安装                → dependency_declared
依赖完全未声明                      → truly_missing
根目录和子包都安装同名依赖          → 优先子包所属依赖
@/views/createuserid.vue            → existing
jsconfig paths 别名                 → existing
tsconfig paths 别名                 → existing
动态且无法静态读取的 alias          → unknown
解析路径试图越出工作区              → blocked
```

### 7.7 验收标准

- Vue 2 基准项目中的两个真实引用不再被误判；
- 包解析不会跨包选择错误依赖；
- 路径边界测试全部通过；
- 旧存在性检查测试保持兼容；
- Server 类型检查通过。

---

## 8. 阶段 2：建立补丁后的虚拟文件图

### 8.1 修复目标

- 在实际写入文件前验证补丁应用后的文件状态；
- 将补丁计划创建的文件标记为 `planned_create`；
- 支持同一补丁内新增和修改文件互相引用；
- 保持真实缺失引用的阻断能力。

### 8.2 修复详情

#### 任务 2.1：构建文件计划

从 `proposePatch` 输入或生成结果中提取：

```ts
{
  creates: ["clr-vue-app/src/router/index.js"],
  modifies: ["clr-vue-app/src/main.js"],
  deletes: []
}
```

规范化要求：

- 路径统一为工作区相对路径；
- 禁止 `..` 和工作区外绝对路径；
- 同一路径不能同时出现在 create/modify/delete；
- 文件状态必须与磁盘状态相符；
- 已存在文件不能伪装为 create；
- 不存在文件不能伪装为 modify。

#### 任务 2.2：虚拟解析相对引用

验证 `main.js` 中的：

```js
import router from "./router";
```

解析候选时同时查询：

- 当前磁盘文件；
- `plannedFileGraph.creates`；
- 计划创建文件的扩展名候选；
- 计划创建目录下的 `index.js/ts/tsx/vue`。

预期：

```text
./router → clr-vue-app/src/router/index.js → planned_create
```

#### 任务 2.3：补丁内容级 import 校验

对每个新增或修改文件的最终内容提取 import，并基于同一个虚拟文件图校验。

校验必须分两次：

1. 补丁生成前：验证计划和已知引用；
2. 补丁生成后：验证最终补丁内容中的全部静态 import。

### 8.3 预计新增或修改文件

- 新增 `apps/server/src/existenceChecker/plannedFileResolver.ts`
- 新增 `apps/server/src/existenceChecker/plannedFileResolver.test.ts`
- 修改 `apps/server/src/existenceChecker/existenceChecker.ts`
- 修改 `apps/server/src/agentPatchTools.ts`
- 修改 `apps/server/src/agentPatchTools.test.ts`
- 修改 `apps/server/src/editPatchService.ts`
- 修改 `apps/server/src/editPatchService.test.ts`
- 新增 `scripts/check-agent-new-file-stage2.ps1`

### 8.4 修复结果（阶段完成后）

基准案例应得到：

```text
vue-router               → dependency_installed
@/views/createuserid.vue → existing
./router                 → planned_create
```

最终补丁可以同时包含：

- 新增 `clr-vue-app/src/router/index.js`；
- 修改 `clr-vue-app/src/main.js`。

### 8.5 验收脚本

```powershell
$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot

try {
    & pnpm.cmd --filter "@mini-ai-web-editor/server" exec tsx --test `
        src/existenceChecker/plannedFileResolver.test.ts `
        src/existenceChecker/existenceChecker.test.ts `
        src/agentPatchTools.test.ts `
        src/editPatchService.test.ts
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    & pnpm.cmd --filter "@mini-ai-web-editor/server" typecheck
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
```

执行命令：

```powershell
pnpm verify:agent-new-file-stage2
```

### 8.6 必测场景

```text
已有文件引用计划新增文件            → planned_create
计划新增文件引用另一个计划新增文件  → planned_create
目录 import 命中计划新增 index.js   → planned_create
补丁引用未创建也不存在的文件        → truly_missing
同一路径同时 create 和 delete       → 拒绝文件计划
create 覆盖已有文件                 → 拒绝文件计划
计划路径越出工作区                  → 拒绝文件计划
补丁最终内容新增未知 import         → 阻止补丁
```

### 8.7 验收标准

- 双文件补丁引用图验证通过；
- 真正缺失引用测试仍然失败并给出准确原因；
- 不写入真实用户工作区；
- Server 类型检查通过；
- 补丁和文件编辑现有回归测试通过。

---

## 9. 阶段 3：按编辑类型重构工作流门禁

### 9.1 修复目标

- 允许安全的新文件创建；
- 避免一项不相关的旧检查永久阻塞全部编辑；
- 为 create、modify、delete 建立不同前置条件；
- 让门禁返回真正可以解除阻塞的恢复建议。

### 9.2 修复详情

#### 任务 3.1：按目标记录检查结果

将：

```ts
unresolvedExistenceChecks: string[]
```

逐步迁移为：

```ts
referenceChecks: Record<string, ReferenceResolution>;
```

规则：

- 相同目标的新检查覆盖旧状态；
- 不相关目标的旧缺失不阻止当前补丁；
- 门禁只检查本次编辑文件计划实际依赖的引用；
- Context 摘要保留结构化状态，不再只保存字符串。

#### 任务 3.2：拆分编辑门禁

| 工具和操作 | 必须满足的条件 |
| --- | --- |
| `proposePatch(create)` | 路径在工作区；计划引用可在补丁后解析 |
| `proposePatch(modify)` | 文件存在并已读取；计划引用可解析 |
| `writeFile(createIfMissing=true)` | 目标不存在；路径安全；创建授权有效 |
| `writeFile` 覆盖文件 | 文件存在并已读取；Safe Editor 允许 |
| `replaceInFile` | 文件存在并已读取；搜索块准确匹配 |
| `delete` | 文件存在；用户授权；影响分析满足要求 |

#### 任务 3.3：修正恢复建议

门禁返回结构：

```ts
type WorkflowBlockDecision = {
  reason: string;
  blockingReferences: ReferenceResolution[];
  recommendedTools: string[];
  recoverable: boolean;
};
```

如果目标属于 `planned_create`，不得推荐继续执行相同的 `checkExistence`。

### 9.3 预计新增或修改文件

- 修改 `apps/server/src/agentToolTypes.ts`
- 修改 `apps/server/src/agentTools.ts`
- 修改 `apps/server/src/taskWorkflow/types.ts`
- 修改 `apps/server/src/taskWorkflow/decisionPolicy.ts`
- 修改 `apps/server/src/taskWorkflow/decisionPolicy.test.ts`
- 修改 `apps/server/src/agentRuntime.ts`
- 修改 `apps/server/src/agentRuntime.test.ts`
- 修改 `apps/server/src/contextBudget/summary.ts`
- 修改 `apps/server/src/agentFileEditTools.test.ts`
- 新增 `scripts/check-agent-new-file-stage3.ps1`

### 9.4 修复结果（阶段完成后）

- `proposePatch` 可以为不存在的路由文件生成补丁；
- `writeFile(createIfMissing=true)` 不会因目标不存在而被工作流拦截；
- 修改已有文件仍必须满足读取和安全编辑要求；
- 真正缺失外部引用仍能阻止编辑；
- 门禁不再形成“创建前要求目标已存在”的循环。

### 9.5 验收脚本

```powershell
$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot

try {
    & pnpm.cmd --filter "@mini-ai-web-editor/server" exec tsx --test `
        src/taskWorkflow/decisionPolicy.test.ts `
        src/agentRuntime.test.ts `
        src/agentTools.test.ts `
        src/agentFileEditTools.test.ts `
        src/agentPatchTools.test.ts
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    & pnpm.cmd --filter "@mini-ai-web-editor/server" typecheck
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
```

执行命令：

```powershell
pnpm verify:agent-new-file-stage3
```

### 9.6 验收标准

- 新增路由文件场景能够产生待审核补丁；
- 已有文件未读取时仍不能直接覆盖；
- 工作区越界写入仍被阻止；
- 旧的缺失检查不会阻止无关文件编辑；
- 工作流、Agent 工具和 Runtime 专项测试通过。

---

## 10. 阶段 4：修复任务完成语义与状态持久化

### 10.1 修复目标

- 编辑任务不能以“返回了一段文本”作为成功依据；
- 零补丁、零文件变更和未完成计划不能标记为成功；
- Runtime、任务会话和前端 API 使用一致的结束状态；
- 为后续二次完成检查提供基础。

### 10.2 修复详情

#### 任务 4.1：建立交付条件检查器

新增：

```ts
type CompletionEvidence = {
  workflowType?: TaskWorkflowType;
  mutationExpected: boolean;
  generatedPatchCount: number;
  changedFileCount: number;
  pendingPlanCount: number;
  blockedPlanCount: number;
  validationAttempted: boolean;
};
```

编辑任务完成条件：

```text
存在已生成补丁并进入 awaiting_approval
或
存在已应用文件变更，且计划没有未完成实现步骤
```

不得判定为完成的情况：

- `filesChanged=[]` 且 `generatedPatchIds=[]`；
- 仍有 `implement` 阶段处于 pending；
- 最终回答明确表示“任务尚未完成”；
- 仅输出了示例代码但没有补丁或写入结果；
- 编辑工具持续被阻止。

#### 任务 4.2：扩展 Runtime 状态

增加 `incomplete` 和 `blocked`，并同步：

- Runtime 返回类型；
- 任务会话持久化；
- Plan 模式状态映射；
- 运行指标；
- API Contract；
- 任务恢复入口。

#### 任务 4.3：完成前二次检查

模型准备结束时，Runtime 先执行确定性检查：

```text
编辑任务 + 无交付物 + 仍有可用工具
→ 注入一次恢复提示
→ 允许模型继续生成补丁
```

只有以下情况可以返回 `blocked`：

- 缺少用户必须作出的选择；
- 缺少明确权限；
- 外部状态无法自动获得；
- 安全策略禁止继续。

### 10.3 预计新增或修改文件

- 新增 `apps/server/src/agentCompletionPolicy.ts`
- 新增 `apps/server/src/agentCompletionPolicy.test.ts`
- 修改 `apps/server/src/agentRuntime.ts`
- 修改 `apps/server/src/agentRuntime.test.ts`
- 修改 `apps/server/src/taskWorkflow/taskWorkflowEngine.ts`
- 修改 `apps/server/src/taskWorkflow/taskWorkflowEngine.test.ts`
- 修改 `apps/server/src/taskSessionStore.ts`
- 修改 `apps/server/src/taskSessionStore.test.ts`
- 修改 `apps/server/src/observability/runMetrics.ts`
- 修改 `apps/server/src/types.ts`
- 修改 `apps/server/src/index.ts`
- 新增 `scripts/check-agent-new-file-stage4.ps1`

### 10.4 修复结果（阶段完成后）

原始失败案例如果仍未产生补丁，应记录为：

```text
incomplete 或 blocked
```

不能再出现：

```text
status=success
filesChanged=[]
generatedPatchIds=[]
plan implement=pending
```

### 10.5 验收脚本

```powershell
$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot

try {
    & pnpm.cmd --filter "@mini-ai-web-editor/server" exec tsx --test `
        src/agentCompletionPolicy.test.ts `
        src/agentRuntime.test.ts `
        src/taskWorkflow/taskWorkflowEngine.test.ts `
        src/taskSessionStore.test.ts `
        src/observability/runMetrics.test.ts
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    & pnpm.cmd --filter "@mini-ai-web-editor/server" typecheck
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
```

执行命令：

```powershell
pnpm verify:agent-new-file-stage4
```

### 10.6 必测场景

```text
编辑任务生成待审核补丁                → awaiting_approval
直接写入且计划完成                    → completed
编辑任务零补丁零变更                  → incomplete
存在必须由用户选择的歧义              → blocked
分析型任务正常返回结论                → completed
编辑任务最终文本声称未完成            → 不得 completed
计划 implement/validate 仍 pending     → 不得 completed
达到工具步骤上限                      → step_limit_reached
```

### 10.7 验收标准

- Runtime、任务会话、指标和 API 状态一致；
- 零交付物编辑任务不再显示成功；
- 分析型任务不受编辑完成条件影响；
- 状态迁移测试完整；
- Server 类型检查通过。

---

## 11. 阶段 5：优化无进展恢复、预算策略与 Prompt

### 11.1 修复目标

- 将“没有找到已有文件”转换为创建动作；
- 避免在明确新增意图后继续宽泛搜索；
- 在预算收敛阶段保留完成任务所需工具；
- 消除 Prompt 中“允许创建”与“所有引用必须预先存在”的冲突。

### 11.2 修复详情

#### 任务 5.1：识别创建型负面证据

当以下条件同时成立：

- 用户意图为 feature/edit；
- 文件名或职责明确；
- exhaustive 搜索确认目标不存在；
- 工作区修改已授权；

生成策略事实：

```text
目标文件不存在，已确认需要创建；
停止继续搜索同名文件；
下一步构建文件计划并调用 proposePatch 或 writeFile(createIfMissing=true)。
```

#### 任务 5.2：优化预算阶段工具集

进入 convergence 阶段后保留：

- 精确读取；
- `proposePatch`；
- `writeFile`；
- `replaceInFile`；
- `applyPatch`；
- 必要的 `runCommand`。

禁用：

- 已经得到 exhaustive 负面证据后的同范围搜索；
- 无法解除当前门禁的重复检查；
- 与文件计划无关的相似模式搜索。

#### 任务 5.3：修订 Prompt

明确以下规则：

1. `target_absent` 对新增功能通常表示需要创建；
2. 本次补丁创建的文件不要求在补丁前存在；
3. 外部依赖和已有引用必须解析；
4. 补丁内部引用必须在补丁后虚拟文件图中解析；
5. Act 模式有修改授权时不能只输出手工教程；
6. 最终回答前必须检查补丁、文件变更和计划状态；
7. 只有真实阻塞时才要求用户再次授权。

### 11.3 预计新增或修改文件

- 修改 `apps/server/src/agentRuntime.ts`
- 修改 `apps/server/src/agentBudgetPolicy.ts`
- 修改 `apps/server/src/agentRuntime.test.ts`
- 修改 `apps/server/src/prompts.ts`
- 修改 `apps/server/src/prompts.test.ts`
- 修改 `apps/server/src/codeDiscovery/types.ts`
- 修改负面证据相关工具测试
- 新增 `scripts/check-agent-new-file-stage5.ps1`

### 11.4 修复结果（阶段完成后）

基准案例的决策链应收敛为：

```text
搜索 router
→ exhaustive target_absent
→ 标记 create intent
→ 读取 main.js 和 createuserid.vue
→ 生成双文件计划
→ proposePatch
→ awaiting_approval
```

不得再出现：

- 重复搜索 `router`、`VueRouter`、`new Router`；
- 对同一个未来引用重复执行无法成功的 `checkExistence`；
- 预算只剩数步时继续读取无关项目文件；
- 有编辑授权却要求用户再次提供编辑授权。

### 11.5 验收脚本

```powershell
$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot

try {
    & pnpm.cmd --filter "@mini-ai-web-editor/server" exec tsx --test `
        src/agentRuntime.test.ts `
        src/agentBudgetPolicy.test.ts `
        src/prompts.test.ts `
        src/codeDiscovery/codeDiscovery.test.ts
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    & pnpm.cmd --filter "@mini-ai-web-editor/server" typecheck
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
```

执行命令：

```powershell
pnpm verify:agent-new-file-stage5
```

### 11.6 验收标准

- 负面证据能够触发创建策略；
- 同范围重复搜索被抑制；
- 预算收敛阶段仍能生成补丁；
- Prompt 测试覆盖新增文件规则；
- 原有 no-progress 和 step-limit 测试不回归。

---

## 12. 阶段 6：前端状态展示与可观测性

### 12.1 修复目标

- 用户能够看出 Agent 是完成、未完成还是被门禁阻塞；
- 展示引用状态和计划创建文件；
- 日志能够直接解释门禁决策；
- 修复任务日志中的中文编码和 JSON 完整性问题。

### 12.2 修复详情

#### 任务 6.1：前端状态映射

新增展示：

| 状态 | UI 文案 | 建议颜色 |
| --- | --- | --- |
| `completed` | 已完成 | 绿色 |
| `awaiting_approval` | 等待审批 | 蓝色 |
| `incomplete` | 尚未完成，可继续 | 黄色 |
| `blocked` | 已阻塞，需要处理 | 橙色 |
| `step_limit_reached` | 达到步骤上限 | 红色 |
| `no_progress` | 无进展停止 | 红色 |

不得将 `incomplete`、`blocked` 映射成成功。

#### 任务 6.2：展示门禁事实

Agent 步骤面板展示：

```text
计划创建：clr-vue-app/src/router/index.js
已解析：vue-router
已解析：@/views/createuserid.vue
补丁后可解析：./router
```

如果阻塞，展示：

```text
阻塞引用
阻塞原因
推荐恢复工具
是否需要用户操作
```

#### 任务 6.3：日志完整性

每次工作流门禁记录：

```json
{
  "workflowType": "feature",
  "toolName": "proposePatch",
  "plannedFiles": ["clr-vue-app/src/router/index.js"],
  "blockingReferences": [],
  "decision": "allowed"
}
```

任务结束记录：

```json
{
  "requestedStatus": "completed",
  "effectiveStatus": "incomplete",
  "completionEvidence": {
    "generatedPatchCount": 0,
    "changedFileCount": 0,
    "pendingPlanCount": 4
  }
}
```

所有 JSON 文件必须：

- 使用 UTF-8；
- 能被 `JSON.parse` 正常读取；
- 原子写入，避免中途截断；
- 中文字段不出现乱码。

### 12.3 预计新增或修改文件

- 修改 `apps/web/src/api.ts`
- 修改 `apps/web/src/hooks/useTaskSessions.ts`
- 修改 `apps/web/src/components/TaskPlanPanel.tsx`
- 修改 `apps/web/src/components/chat/AgentStepsPanel.tsx`
- 修改 `apps/web/src/styles/chat.css`
- 修改 `apps/server/src/routeAgentSteps.ts`
- 修改 `apps/server/src/taskSessionStore.ts`
- 修改 `apps/server/src/observability/runMetrics.ts`
- 新增或修改对应前后端测试
- 新增 `scripts/check-agent-new-file-stage6.ps1`

### 12.4 修复结果（阶段完成后）

- 用户不会再看到“任务成功但文件变更为零”；
- 任务面板能够显示计划创建的文件；
- Runtime 门禁原因可以从日志直接定位；
- 任务会话日志可以被标准 JSON 解析器读取；
- 中文日志完整可读。

### 12.5 验收脚本

```powershell
$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot

try {
    & pnpm.cmd --filter "@mini-ai-web-editor/server" exec tsx --test `
        src/taskSessionStore.test.ts `
        src/observability/runMetrics.test.ts `
        src/agentRuntime.test.ts
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    & pnpm.cmd --filter "@mini-ai-web-editor/server" typecheck
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    & pnpm.cmd --filter "@mini-ai-web-editor/web" typecheck
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    & pnpm.cmd --filter "@mini-ai-web-editor/web" build
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
```

执行命令：

```powershell
pnpm verify:agent-new-file-stage6
```

### 12.6 验收标准

- 六种 Runtime 状态均有明确 UI；
- `incomplete` 和 `blocked` 不使用成功样式；
- 结构化门禁日志可查询；
- 中文任务日志可被 `ConvertFrom-Json` 和 `JSON.parse` 读取；
- Server/Web 类型检查和 Web 构建通过。

---

## 13. 阶段 7：端到端验收、全量回归与灰度收口

### 13.1 修复目标

- 使用真实失败案例验证完整链路；
- 验证没有破坏已有文件修改、删除、审批和命令执行流程；
- 增加可重复的一键验收脚本；
- 为上线提供灰度开关和回滚边界。

### 13.2 修复详情

#### 任务 7.1：新增端到端验收

输入：

```text
将 createuserid.vue 页面添加到路由中，
路由地址 /createUserId，
访问 / 时重定向到 /createUserId。
```

期望 Agent 行为：

1. 确认 `src/router` 不存在；
2. 将其解释为新增文件需求；
3. 读取 `src/main.js`、`src/views/createuserid.vue` 和 `package.json`；
4. 正确解析 `vue-router` 与 `@` 别名；
5. 生成文件计划；
6. 生成新增 `src/router/index.js` 的补丁；
7. 生成修改 `src/main.js` 的补丁；
8. 返回 `awaiting_approval`；
9. 补丁批准后写入两个文件；
10. 执行构建验证；
11. 验证成功后标记 `completed`。

#### 任务 7.2：验证最终文件

`src/router/index.js` 至少包含：

```js
import Vue from "vue";
import VueRouter from "vue-router";
import CreateUserId from "@/views/createuserid.vue";

Vue.use(VueRouter);

export default new VueRouter({
  routes: [
    {
      path: "/createUserId",
      name: "CreateUserId",
      component: CreateUserId
    },
    {
      path: "/",
      redirect: "/createUserId"
    }
  ]
});
```

`src/main.js` 至少包含：

```js
import router from "./router";

new Vue({
  router,
  render: h => h(App)
}).$mount("#app");
```

具体格式必须遵循目标项目现有代码风格，验收不依赖分号或单双引号差异。

#### 任务 7.3：增加灰度开关

建议增加：

```text
AGENT_PLANNED_FILE_RESOLUTION
AGENT_SEMANTIC_COMPLETION_CHECK
```

要求：

- 测试环境默认开启；
- 开发环境可显式切换；
- 灰度期间记录新旧决策差异；
- 稳定后移除旧门禁逻辑和临时兼容字段。

### 13.3 预计新增或修改文件

- 新增 `apps/server/src/acceptance/agentNewFileAcceptance.test.ts`
- 修改 `apps/server/src/acceptance/stage7Acceptance.test.ts` 或增加独立入口
- 修改 `apps/server/src/featureFlags.ts`
- 修改 `apps/server/src/featureFlags.test.ts`
- 新增 `scripts/check-agent-new-file-stage7.ps1`
- 修改根 `package.json`，增加最终验收命令

### 13.4 修复结果（阶段完成后）

- 原始路由任务能够自主创建缺失文件；
- Agent 不再输出“请手工创建”作为有权限编辑任务的最终结果；
- 双文件补丁可以审核、应用和验证；
- 任务状态与实际交付一致；
- 全量测试、类型检查和生产构建通过。

### 13.5 最终验收脚本

计划新增 `scripts/check-agent-new-file-stage7.ps1`：

```powershell
$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

function Invoke-VerificationStep {
    param(
        [Parameter(Mandatory = $true)][string]$Title,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    Write-Host "`n[Agent New File] $Title" -ForegroundColor Cyan
    & pnpm.cmd @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Title failed with exit code $LASTEXITCODE"
    }
}

Push-Location $repoRoot
try {
    Invoke-VerificationStep `
        -Title "new-file end-to-end acceptance" `
        -Arguments @(
            "--filter", "@mini-ai-web-editor/server",
            "exec", "tsx", "--test",
            "src/acceptance/agentNewFileAcceptance.test.ts"
        )

    Invoke-VerificationStep `
        -Title "existence and workflow regressions" `
        -Arguments @(
            "--filter", "@mini-ai-web-editor/server",
            "exec", "tsx", "--test",
            "src/existenceChecker/existenceChecker.test.ts",
            "src/existenceChecker/packageResolver.test.ts",
            "src/existenceChecker/aliasResolver.test.ts",
            "src/existenceChecker/plannedFileResolver.test.ts",
            "src/taskWorkflow/decisionPolicy.test.ts",
            "src/agentCompletionPolicy.test.ts",
            "src/agentRuntime.test.ts",
            "src/agentPatchTools.test.ts",
            "src/agentFileEditTools.test.ts"
        )

    Invoke-VerificationStep `
        -Title "server full regression" `
        -Arguments @("--filter", "@mini-ai-web-editor/server", "test")

    Invoke-VerificationStep `
        -Title "server typecheck" `
        -Arguments @("--filter", "@mini-ai-web-editor/server", "typecheck")

    Invoke-VerificationStep `
        -Title "web typecheck" `
        -Arguments @("--filter", "@mini-ai-web-editor/web", "typecheck")

    Invoke-VerificationStep `
        -Title "web production build" `
        -Arguments @("--filter", "@mini-ai-web-editor/web", "build")

    Write-Host "`nAgent new-file autonomy acceptance passed." -ForegroundColor Green
}
finally {
    Pop-Location
}
```

最终执行命令：

```powershell
pnpm verify:agent-new-file-stage7
```

### 13.6 最终验收标准

- 原始 Vue 2 路由案例通过；
- 新文件创建、已有文件修改和补丁审批链路通过；
- `./router` 被识别为 `planned_create`；
- `vue-router` 被识别为 `dependency_installed`；
- `@/views/createuserid.vue` 被识别为 `existing`；
- 编辑任务零补丁零变更不能返回 `completed`；
- 真正缺失的外部引用仍能阻止编辑；
- 工作区越界写入仍被阻止；
- Server 全量测试通过；
- Server/Web 类型检查通过；
- Web 生产构建通过；
- 任务会话日志为合法 UTF-8 JSON。

---

## 14. 全阶段验收命令汇总

各阶段实施后，根 `package.json` 应逐步增加：

```json
{
  "scripts": {
    "verify:agent-new-file-stage0": "powershell -ExecutionPolicy Bypass -File scripts/check-agent-new-file-stage0.ps1",
    "verify:agent-new-file-stage1": "powershell -ExecutionPolicy Bypass -File scripts/check-agent-new-file-stage1.ps1",
    "verify:agent-new-file-stage2": "powershell -ExecutionPolicy Bypass -File scripts/check-agent-new-file-stage2.ps1",
    "verify:agent-new-file-stage3": "powershell -ExecutionPolicy Bypass -File scripts/check-agent-new-file-stage3.ps1",
    "verify:agent-new-file-stage4": "powershell -ExecutionPolicy Bypass -File scripts/check-agent-new-file-stage4.ps1",
    "verify:agent-new-file-stage5": "powershell -ExecutionPolicy Bypass -File scripts/check-agent-new-file-stage5.ps1",
    "verify:agent-new-file-stage6": "powershell -ExecutionPolicy Bypass -File scripts/check-agent-new-file-stage6.ps1",
    "verify:agent-new-file-stage7": "powershell -ExecutionPolicy Bypass -File scripts/check-agent-new-file-stage7.ps1"
  }
}
```

完整验收顺序：

```powershell
pnpm verify:agent-new-file-stage0
pnpm verify:agent-new-file-stage1
pnpm verify:agent-new-file-stage2
pnpm verify:agent-new-file-stage3
pnpm verify:agent-new-file-stage4
pnpm verify:agent-new-file-stage5
pnpm verify:agent-new-file-stage6
pnpm verify:agent-new-file-stage7
```

## 15. 风险与回滚策略

### 15.1 主要风险

| 风险 | 影响 | 控制方式 |
| --- | --- | --- |
| `planned_create` 放行过宽 | 生成引用仍不完整的补丁 | 补丁后虚拟文件图二次校验 |
| 包解析选择错误子包 | 使用错误依赖或版本 | 最近包边界优先，多候选返回 ambiguous |
| 框架别名误识别 | 错误放行 import | 静态规则、候选路径验证、构建复验 |
| 完成判定过严 | 合法分析任务被标记未完成 | 仅对 mutationExpected 的工作流启用 |
| 状态扩展影响前端兼容 | 旧 UI 显示异常 | API 兼容映射和前端穷举测试 |
| Prompt 与 Runtime 再次不一致 | 模型重复无效操作 | Runtime 为事实来源，Prompt 只提供决策指导 |

### 15.2 回滚边界

- 阶段 1 可独立回滚包和别名解析器；
- 阶段 2 可通过 feature flag 关闭虚拟文件图；
- 阶段 3 保留旧 `unresolvedExistenceChecks` 兼容字段直到阶段 7；
- 阶段 4 的新状态需要保留旧 API 映射，避免前端旧版本崩溃；
- 阶段 5 的 Prompt 修改可独立回滚，不影响底层正确性；
- 阶段 6 的 UI 和日志改动不得改变 Runtime 决策；
- 阶段 7 灰度稳定后才删除旧逻辑。

## 16. 完成定义

只有同时满足以下条件，整个修复才算完成：

- 八个阶段验收脚本全部通过；
- 原始 Vue 2 路由任务能够生成并应用双文件变更；
- Runtime 不再出现新增文件前置存在性死锁；
- 真实缺失和歧义引用仍受到保护；
- 编辑任务完成状态与实际补丁、文件和计划一致；
- 前端能够准确展示所有结束状态；
- 中文日志和任务会话 JSON 完整可读；
- 全量测试、双端类型检查和 Web 生产构建通过；
- 未引入新的第三方依赖；
- 没有重构与本问题无关的模块。

