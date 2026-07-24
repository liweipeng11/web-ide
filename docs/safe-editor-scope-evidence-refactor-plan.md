# Safe Editor 范围证据重构计划

## 1. 背景与目标

当前 Safe Editor 在没有显式目标或 `analyzeImpact` 结果时，会把候选补丁中的所有文件同时标记为：

- `missing_impact_analysis`
- `scope_expansion`

这会把“缺少证据”和“已确认超出范围”混为一谈。本文档记录阶段 0 的故障基线，以及后续修复阶段的边界与验收方向。

## 2. 技术与依赖约束

- 服务端：TypeScript、Node.js、Express。
- 前端：React 18、Vite。
- 工作区与包管理：pnpm workspace。
- 测试：Node Test Runner、`tsx --test`。
- 验收入口：PowerShell。
- 不新增第三方依赖，不手动修改 `pnpm-lock.yaml`。
- 优先复用 Safe Editor、影响分析、虚拟文件图、Pending Patch、Checkpoint、Feature Flag 和运行指标能力。

## 3. 阶段路线图

| 阶段 | 目标 | 状态 |
| --- | --- | --- |
| 0 | 建立故障基线与真实扩散对照 | 已完成 |
| 1 | 区分缺少证据、分析不完整和真实范围扩散 | 已完成 |
| 2 | 建立补丁生成前的结构化修改计划 | 已完成 |
| 3 | 按修改计划动态执行影响分析预检 | 待实施 |
| 4 | 接入补丁链路并限制自动恢复次数 | 待实施 |
| 5 | 修复前端状态语义与结构化审批体验 | 待实施 |
| 6 | 端到端验收、指标、灰度与回滚收口 | 待实施 |

## 4. 阶段 0：故障基线

### 4.1 范围

阶段 0 只增加测试、验收入口和文档，不修改 Safe Editor 生产行为。

基线案例构造以下候选补丁：

- 创建 `clr-vue-app/src/router/index.js`。
- 修改 `clr-vue-app/src/main.js`。
- 不提供显式目标或影响分析证据。

真实扩散对照在明确声明上述双文件范围后，额外修改：

- `clr-vue-app/src/components/Unrelated.vue`。

测试直接调用纯函数，不请求真实 AI 服务，也不读写工作区业务文件。

### 4.2 已记录的基线结果

阶段 0 记录的缺少证据双文件故障：

- `evidenceSource === "none"`。
- 两个文件的角色均为 `expansion`。
- 每个文件同时产生 `missing_impact_analysis` 和 `scope_expansion`。
- 两类风险均为高风险，最终状态为 `high_risk`。
- 按现有补丁应用契约，`high_risk` 需要用户显式确认后才能继续。

真实扩散对照：

- 双文件目标来自 `explicit_target`，角色均为 `required`。
- `Unrelated.vue` 是唯一的 `expansion`。
- 只有 `Unrelated.vue` 产生 `scope_expansion`。
- 最终状态仍为 `high_risk`，确保后续修复不能放行真实扩散。

### 4.3 验收

执行：

```powershell
pnpm verify:safe-editor-stage0
```

该入口依次运行：

1. Safe Editor 原有单元测试。
2. 阶段 0 双文件故障基线与真实扩散对照。
3. 服务端 TypeScript 类型检查。

验收标准：

- Vue Router 双文件错误语义可以稳定复现。
- 真实扩散文件仍能被单独识别。
- 测试不依赖网络或真实 AI 服务。
- 测试不修改任何真实业务文件。

## 5. 阶段 1：状态语义重构

### 5.1 数据模型

- 状态新增 `needs_analysis`，用于缺少证据或证据不完整。
- 文件角色新增 `unverified`，表示当前不能确认文件是否位于最小修改集合。
- 新报告使用可组合的 `evidence.sources`、`evidence.complete` 和 `evidence.diagnostics`。
- 旧 `evidenceSource` 与 `impactAnalysisComplete` 字段继续写入，历史报告缺少 `evidence` 时可按旧字段推导。

### 5.2 分类与门禁规则

- 完全无证据：文件为 `unverified`，只产生 `missing_impact_analysis`，报告为 `needs_analysis`。
- 分析不完整：已解析目标仍可标记为 `required`，其他候选为 `unverified`，报告为 `needs_analysis`。
- 可靠且完整的范围之外：文件为 `expansion`，产生 `scope_expansion`，报告为 `high_risk`。
- `needs_analysis` 补丁不能通过 `acknowledgeSafeEditRisk` 普通风险确认直接应用。

### 5.3 阶段结果

Vue Router 双文件案例由阶段 0 的：

```text
high_risk + expansion + missing_impact_analysis + scope_expansion
```

变为：

```text
needs_analysis + unverified + missing_impact_analysis
```

明确双文件范围后额外修改 `Unrelated.vue` 仍然是：

```text
high_risk + expansion + scope_expansion
```

### 5.4 验收

```powershell
pnpm verify:safe-editor-stage1
```

该命令覆盖状态语义、Vue Router 回归、补丁应用门禁、Server 类型检查和 Web 类型检查。

## 6. 阶段 2：结构化修改计划

### 6.1 数据模型与门禁

- `proposePatch` 新增 `plannedChanges` 参数，同时保留 `planFileChanges` 工具供直接编辑链路提前声明完整文件集合。
- 每个文件必须包含工作区相对路径、`create/modify/delete/rename/signature` 类型和非空修改原因；签名变更可附带 `symbolName`。
- 计划拒绝绝对路径、目录穿越和大小写不敏感的重复文件。
- 服务端在补丁生成前校验磁盘状态：`create` 目标不得存在，其余目标必须是现有文件。
- 文件级计划与展示用 Todo 分离持久化，审批暂停和任务恢复后仍可审计。
- `proposePatch`、`replaceInFile` 和 `writeFile` 在缺少计划时被阻断；指定目标不在当前计划中时必须先更新计划。

### 6.2 Safe Editor 语义

- 结构化计划作为 `agent_plan` 证据进入推荐模型。
- 计划文件构成补丁生成前的最小修改集合，不能由候选补丁反向扩大。
- `editScope` 进入严格计划模式，计划外路径以及与计划不一致的 create/modify/delete 状态都会被拒绝并触发重新生成。
- 影响分析与计划同时存在时合并已解析目标，并同时保留 `impact_analysis` 与 `agent_plan` 证据来源。
- 计划外候选仍产生 `scope_expansion`，保持 `high_risk`，不会因计划能力上线而放宽。

### 6.3 验收

```powershell
pnpm verify:safe-editor-stage2
```

该入口覆盖结构化计划校验、Agent 上下文与任务会话持久化、编辑前门禁、Safe Editor 分类、Vue Router 双文件回归、补丁应用门禁、Prompt 约束及 Server/Web 类型检查。

## 7. 后续阶段边界

- 阶段 2 至阶段 4 负责建立计划、动态预检和自动恢复，不应通过候选补丁反向扩大安全范围。
- 阶段 5 负责把 `needs_analysis` 与真实 `high_risk` 在界面和审批动作上分离。
- 阶段 6 必须同时验证 Vue Router 双文件正常通过，以及 `Unrelated.vue` 继续被拦截。

## 8. 回滚

阶段 0 不改变运行时行为。若验收入口本身造成环境兼容问题，可独立回滚根命令、PowerShell 脚本、基线测试和本文档，不影响生产链路。
