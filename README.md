# Mini AI Web Editor

Mini AI Web Editor 是一个本地优先的浏览器端 AI 编码工作台。它把 Monaco 编辑器、项目级 AI 辅助、可审阅的多文件补丁、任务历史、本地终端、验证修复流程和 Git 工作流整合在一起，同时把工作区文件访问限制在本地 Node.js 服务内。

当前项目的定位不是完全自动化的云端开发平台，而是一个透明、可控、可回滚的本地编码 Agent：先理解上下文，再生成可审查补丁，由用户决定是否应用、验证和提交。

## 阶段 5：集成验收与默认启用

阶段 0-4 完成的 Context Budget V2、Model Provider Gateway、Language Service / LSP 和 Inline Edit 现已默认启用。部署时不配置对应环境变量也会进入新路径；如需紧急回退，可将单项环境变量显式设置为 `0`、`false`、`no` 或 `off`，Capability API 会同步返回实际生效路径。

执行完整发布验收：

```bash
pnpm verify:stage5
```

该命令串联服务端全量测试、服务端与前端类型检查、前端生产构建，并生成 `apps/server/artifacts/evaluation/stage-5-integration.json`。验收报告覆盖四项默认启用检查、四项独立回退检查和十类离线集成场景，完成度低于 90% 时命令返回失败。

## 任务计划与 Runtime 同步发布门禁

涉及任务计划、审批恢复、Runtime 执行证据、完成门禁或任务状态持久化的修改，发布前必须执行：

```bash
pnpm verify:release:task-plan-runtime-sync
```

该命令依次执行任务计划与 Runtime 的九步专项门禁、新文件路由创建验收和任务完成 Stage 8 验收。专项门禁包含跨两次审批的真实文件写入与构建路径，并断言最终状态为 `success`、所有系统计划步骤完成、验证通过、`completeTask` 仅调用一次，且不存在 `PENDING_PLAN` 或 `UNCHANGED_COMPLETION_EVIDENCE`。

## 功能特性

- 在浏览器 UI 中打开并恢复本地项目工作区。
- 浏览项目文件，使用 Monaco Editor 编辑文件，并在工作区内搜索代码。
- 基于选中文件或整个工作区与 AI 对话。
- Agent 在修改前可搜索代码、读取相关文件，再生成变更方案。
- 支持生成多文件修改，也可在需要时创建新文件。
- 流式展示 AI 回复和 Agent 活动，包括工具调用、文件读取、编辑、命令和错误。
- 写入前预览 Diff，可按文件或整体应用/拒绝补丁。
- 应用补丁前检测文件是否已被其他操作修改，避免覆盖新内容。
- 应用补丁前创建 checkpoint，可从任务历史中回滚。
- 持久化聊天历史和任务会话，包括读取文件、修改文件、执行命令、Agent 步骤、checkpoint 和 Git commit 记录。
- 在集成终端中运行项目命令。
- 执行命令前按本地策略判断为安全、需确认或阻止。
- 支持运行构建/测试验证，并在验证失败后生成后续修复补丁。
- 自动发现常见项目命令和包管理器元数据。
- 支持全局级别和项目级别 Project Rules，让 Agent 在聊天、编辑和验证修复时遵守长期规则。
- 支持 Project Memory，在不同聊天和服务重启之间保留项目画像、约定、阶段目标、最近改动、未完成事项和已确认风险。
- 支持 External Context Gateway，让 Agent 按需检索官方文档和互联网、读取公开网页/API 文档，并记录可审计的顺序推理步骤。
- 提供 Git 工作流面板，支持查看状态、创建任务分支、生成提交信息，并只提交当前任务相关文件。

## Agent 工作流

一次典型的编辑任务流程如下：

1. 用户从选中文件或工作区范围描述修改需求。
2. Agent 搜索项目代码并读取相关文件。
3. Agent 生成可审阅的多文件 patch 和建议验证命令。
4. 用户审阅 Diff，并应用全部或部分文件修改。
5. 服务端在写入文件前创建 checkpoint。
6. 用户可按命令安全策略运行验证命令。
7. 如果验证失败，Agent 可继续生成修复 patch，直到成功或达到最大尝试次数。
8. 用户可在 Git 工作流面板中生成 commit message，并提交本次任务相关文件。

AI 生成的修改不会直接写入文件。应用 patch、运行需确认命令、创建分支和提交代码都保留为显式用户动作。

## Git 工作流

Git 工作流是一个独立功能模块，不塞进原有聊天或补丁逻辑里。它把 AI 修改后的代码交付链路补齐为：

```text
需求 -> Agent 生成 patch -> 用户审阅应用 -> 验证 -> 查看 Git 状态 -> 生成提交信息 -> 提交任务文件
```

当前支持：

- 查看当前工作区是否为 Git 仓库。
- 展示当前分支、Git 根目录、变更文件、最近一次提交和 remote。
- 展示 modified、added、deleted、renamed、untracked、conflicted 等文件状态。
- 根据任务目标生成建议分支名，例如 `agent/fix-login-timeout`。
- 创建并切换任务分支。
- 当工作区已有未提交变更时，创建分支前要求用户确认。
- 根据任务会话或选中文件生成 commit message。
- 提交时只 `git add` 指定文件，避免默认 `git add .` 把用户无关改动一起提交。
- 提交成功后把 commit hash、message、文件列表记录到任务会话中。

后端接口：

```text
GET  /api/git-workflow/status
POST /api/git-workflow/branches
POST /api/git-workflow/commit-message
POST /api/git-workflow/commits
```

相关目录：

```text
apps/server/src/gitWorkflow/
  gitService.ts          Git 命令封装和业务逻辑
  routes.ts              Git workflow API 路由
  types.ts               Git workflow 类型
  gitService.test.ts     临时 Git 仓库集成测试

apps/web/src/gitWorkflow/
  api.ts                 前端 Git workflow API 封装
  GitWorkflowPanel.tsx   Git 工作流面板
  types.ts               前端类型
  gitWorkflow.css        面板样式
```

## Project Rules

Project Rules 用于给 Agent 提供长期规则，做法参考主流 AI IDE 的“全局规则 + 工作区规则”分层模型。规则会在 AI 聊天、编辑、自动验证修复等流程中作为 `projectRules` 注入 prompt。

当前支持两级规则：

```text
全局规则：
~/.mini-ai/AGENTS.md
~/.mini-ai/rules/*.md

项目规则：
项目根目录/.mini-ai/AGENTS.md
项目根目录/.mini-ai/rules/*.md
```

服务启动时会自动创建全局目录 `~/.mini-ai/rules`。加载项目时会自动创建项目目录 `.mini-ai/rules`。其中：

- `AGENTS.md` 适合放全局或项目级通用约束。
- `rules/*.md` 适合放可按路径生效的细分规则。
- 旧格式 `AGENTS.md`、`.cursorrules`、`.windsurfrules` 仍会兼容读取，但会作为 legacy 规则显示，推荐迁移到 `.mini-ai`。

项目级通用规则示例：

```md
# Project Rules

- 使用 pnpm，不要使用 npm。
- 修改代码前先搜索现有实现，优先复用已有模块。
- 新增功能必须拆分模块，不要把代码堆在一个文件里。
- 修改后建议运行 server test、server typecheck 和 web typecheck。
- 不要修改 `.mini-ai/state/` 里的运行时数据。
```

路径级规则示例：

```md
---
globs: apps/web/src/**/*.tsx
alwaysApply: false
---

- React 组件保持小而清晰。
- 复杂 UI 逻辑拆到独立组件或 hook。
- 样式放到对应 CSS 文件，不要大量 inline style。
```

`globs` 匹配当前选中文件或聊天上下文文件时，该规则会显示为 Active 并注入给 Agent；否则显示为 Scoped。没有 `globs` 的规则默认 always-on。

在界面中可通过左侧活动栏的 **Project Rules** 面板查看当前发现的规则、生效状态、来源级别和内容预览。

## Project Memory

Project Memory 用于给 Agent 提供跨会话的稳定项目背景，数据写入当前工作区的 `.mini-ai/state/runtime/project-memory.json`。首次读取时会复用 Project Analyzer 生成项目简介和技术栈；后续读取会从任务会话自动汇总真实变更文件和未完成任务。

可长期维护的字段包括项目简介、当前约定、当前阶段目标和已确认风险。最近改动与未完成事项由服务端从任务事实生成，不接受 API 直接覆盖；清理任务历史不会删除已经同步的最近改动。Project Memory 会注入任务计划、连续 Agent、普通问答、直接补丁和自动验证回修链路。注入模型前会按字段限制条目数量和字符预算，并保持 JSON 结构完整；历史任务文本只作为非指令数据，当前用户请求与最新读取的工作区代码始终优先。

在界面中可通过左侧活动栏的 **Project Memory** 面板编辑长期内容、重新扫描技术栈，并查看最近改动与未完成事项。自动生成的简介会随重新扫描更新，手工维护的简介不会被覆盖。

阶段 6 增加了写盘前敏感信息与 Prompt Injection 拦截、跨分支隔离、脱敏召回日志、进程内聚合指标和确定性离线评测。可通过以下环境变量按顺序灰度或紧急回滚：

```env
PROJECT_MEMORY_V3_ENABLED=1
PROJECT_MEMORY_AUTO_EXTRACTION_ENABLED=1
PROJECT_MEMORY_RETRIEVAL_ENABLED=1
PROJECT_MEMORY_VALIDATION_ENABLED=1
PROJECT_MEMORY_USAGE_LOG_ENABLED=1
```

`PROJECT_MEMORY_V3_ENABLED=0` 是总回滚开关，会停止候选写入和所有模型入口的 Memory Prompt 注入。关闭子开关可分别停用自动抽取、召回、来源验证或使用日志。运行 `pnpm verify:stage6` 可执行安全/评测/指标/开关专项测试、服务端全量回归、双端类型检查和前端生产构建。

## External Context Gateway

External Context Gateway 作为连续 Agent 和普通文件问答共用的外部信息接入层，提供：

- `getExternalContextStatus`：在联网前检查搜索密钥、浏览器、代理和官方域名配置。
- `searchOfficialDocs`：在调用方明确给出的官方域名内检索，并在返回前再次过滤域名；只有服务端配置过的域名才标记为已验证官方来源。
- `searchWeb`：通过 Brave Search API 发现最新公开信息，可限制检索域名。
- `browseWebPage`：导航到公开网页，提取可见正文和链接，不执行页面 JavaScript。
- `automateBrowser`：在 Act 模式中通过本机 Chrome/Edge 执行 JavaScript 渲染、点击、输入、按键、选择、等待选择器和截图；所有调用都需要用户审批。
- `fetchApiDocs`：抓取 JSON、YAML、Markdown、纯文本或 HTML 格式的公开 API 文档，并识别 OpenAPI 版本、标题、路径和操作数量。
- `sequenceReasoning`：按运行和分支记录简短、显式的顺序推理步骤，并持久化到 `.mini-ai/state/runtime/external-context/reasoning/`。

搜索能力需要在根目录 `.env` 中配置：

```env
BRAVE_SEARCH_API_KEY=your_brave_search_api_key
```

可选配置包括 `BRAVE_SEARCH_BASE_URL`、`EXTERNAL_CONTEXT_TIMEOUT_MS`、`EXTERNAL_CONTEXT_MAX_RESPONSE_BYTES`、`EXTERNAL_CONTEXT_TRUSTED_DOC_DOMAINS`、`EXTERNAL_BROWSER_EXECUTABLE_PATH`、`EXTERNAL_BROWSER_CHANNEL` 和 `EXTERNAL_BROWSER_PROXY_URL`。未配置搜索密钥时，搜索工具会返回明确错误；网页、API 文档抓取和浏览器自动化仍可独立使用。

所有外部内容均作为不可信数据处理，不会被当作 Agent 指令。网关只接受 HTTP(S)，拒绝含凭据 URL、环回/私网/保留地址和云元数据主机；每次重定向和浏览器访问的新来源都会重新校验，并限制超时、重定向次数、内容类型和响应体大小。搜索端点必须使用 HTTPS，且禁止跨来源重定向，避免泄漏搜索密钥。

某些受控网络会把公网域名映射到 `198.18.0.0/15`。确认这是可信本地代理行为后，可显式设置 `EXTERNAL_CONTEXT_ALLOW_PROXY_MAPPED_ADDRESSES=1`；默认保持关闭，不能为了联网而无条件放开保留地址。浏览器自动化不在 Plan 模式提供，页面交互或仅加载并执行脚本都需要审批，不应用于登录、支付、账户变更或破坏性外部操作。

## 界面功能说明

主界面由左侧活动栏、资源面板、编辑器、聊天面板、终端和 Diff 审阅弹窗组成。

### 左侧活动栏

- 文件：浏览当前工作区文件树。
- 搜索：在工作区内搜索代码。
- Project Rules：查看全局规则、项目规则和路径级规则的生效状态。
- Project Memory：维护跨会话项目简介、约定、阶段目标和风险，并查看自动同步的任务事实。
- Git：打开 Git 工作流面板，查看状态、创建任务分支和提交任务文件。

### 文件面板

- 展示当前工作区目录树。
- 支持打开文件到编辑器。
- 支持显示或隐藏 ignored 文件。
- 切换工作区后会刷新文件树、聊天历史和任务历史。

### 搜索面板

- 使用工作区代码搜索能力查找匹配内容。
- 搜索结果展示文件路径、行号和匹配片段。
- 点击结果可打开对应文件。

### 编辑器

- 使用 Monaco Editor 编辑文件。
- 支持多文件 tab。
- 支持选择、关闭已打开文件。
- 显示文件是否有未保存变更。
- 支持保存当前文件。

### 聊天面板

- 支持普通问答、代码解释、修改请求和命令建议。
- 可选择上下文文件，让 AI 基于指定文件回答。
- 支持新建会话、清空当前会话、删除历史会话。
- 支持删除单条消息。
- 支持从某条消息创建分支对话。
- 支持重跑某条用户消息。
- 流式展示 AI 回复和 Agent steps。
- 当用户提出修改请求时，会自动进入 patch 生成流程。
- 当 AI 建议命令时，会以 `command-suggestion` 形式展示，用户确认后可执行。

### 任务历史

任务历史记录一次 Agent 任务的完整上下文，便于追踪 AI 为什么这样修改。

当前记录：

- 用户目标。
- 任务状态。
- 读取过的文件。
- 修改过的文件。
- 执行过的命令。
- Agent steps。
- checkpoint 列表。
- Git commit 记录。
- 关联聊天，可从任务历史回到对应会话。

### 终端

- 集成本地终端。
- 支持手动运行命令。
- 支持从聊天中的命令建议启动命令。
- 终端执行结果会回传到任务会话。
- 支持显示命令状态、输出摘要和检测到的本地 URL。
- 支持快捷键 `Ctrl+\`` 切换终端显示。
- 支持拖拽调整终端高度。

### Diff 审阅

- AI 生成修改后会展示 Diff 审阅弹窗。
- 支持查看多文件 Diff。
- 支持应用全部修改。
- 支持只应用单个文件修改。
- 支持拒绝全部修改。
- 支持只拒绝单个文件修改。
- 应用前会检查目标文件是否仍与生成 patch 时一致。
- 应用后会创建 checkpoint，用于撤销本次修改。

### 自动验证与修复

- patch 可携带建议验证命令。
- 用户确认后可以运行验证命令。
- 命令会先经过安全策略判断。
- 验证失败后，系统可基于失败输出生成修复 patch。
- 修复过程有最大尝试次数限制，避免无限循环。

## 安全模型

- 本地服务端是唯一允许访问工作区文件的组件。
- 文件操作限制在当前打开的工作区内。
- 常见忽略目录和敏感路径会从普通 AI 文件操作中排除。
- 应用 patch 前，现有文件内容必须仍与生成 patch 时使用的内容一致。
- checkpoint 保存修改前内容，用于回滚。
- 命令执行前会经过本地风险策略判断。
- 未知命令需要确认，已知危险命令模式会被阻止。
- Git commit 只提交显式文件列表，不默认提交整个工作区。

命令策略是应用层防护，不是操作系统或容器级沙箱。执行命令、应用修改、创建分支和提交前仍应审阅内容。

## 环境要求

- Node.js 20 或更高版本
- pnpm 9
- 兼容 OpenAI Chat Completions 的 API
- Git，用于 Git 工作流功能

## 安装

```bash
pnpm install
cp .env.example .env
```

Windows PowerShell 可使用：

```powershell
Copy-Item .env.example .env
```

配置 `.env`：

```env
AI_API_KEY=your_api_key
AI_BASE_URL=https://api.openai.com/v1
AI_MODEL=gpt-4.1-mini
AI_CHAT_TEMPERATURE=0.3
AI_EDIT_TEMPERATURE=0
AI_FULL_IO_LOGGING=1
SERVER_PORT=3001
# Optional: override local app state storage. Defaults to .mini-ai/state/web-editor.
# STATE_DIRECTORY=.mini-ai/state/web-editor
```

首次启动时应用不会自动选择项目目录。可在界面中打开本地文件夹，选中的工作区会保存在本地，下次启动时自动恢复。

## 运行

```bash
pnpm dev
```

- Web UI: <http://localhost:5173>
- 本地服务: <http://localhost:3001>

Vite 会把 `/api` 请求代理到本地服务。终端会话通过同一个服务管理 WebSocket 连接。

## API 概览

后端 API 按功能分组组织。下面只列出主要接口，具体请求和响应类型可参考 `apps/server/src/types.ts`、`apps/web/src/api.ts` 和 `apps/server/src/gitWorkflow/types.ts`。

### Workspace

```text
GET  /api/workspace
POST /api/workspace/open
POST /api/workspace/pick
```

用于读取当前工作区、打开指定工作区，或通过系统选择器选择工作区。

### Files

```text
GET  /api/files
GET  /api/file
POST /api/file
```

用于列出文件树、读取文件内容和保存文件。

### Search

```text
GET /api/search
```

用于在当前工作区中搜索代码。

### Commands

```text
GET  /api/commands
POST /api/commands/policy
POST /api/commands/run
```

用于发现项目命令、评估命令风险，并在本地执行命令。

### Project Rules

```text
GET /api/project-rules
```

用于读取全局规则、项目规则和 legacy 规则，并根据当前上下文路径计算规则是否生效。可通过 query 参数重复传入 `path`，例如：

```text
GET /api/project-rules?path=apps/web/src/App.tsx
```

### Project Memory

```text
GET   /api/project-memory
PATCH /api/project-memory
POST  /api/project-memory/refresh
GET   /api/project-memory/metrics
GET   /api/project-memory/evaluation
GET   /api/project-memory/feature-flags
```

`PATCH` 可更新 `projectSummary`、`currentGoals` 和 `confirmedRisks`；`refresh` 会重新扫描技术栈，同时保留手工维护的长期内容。其余三个只读端点分别返回不含 Memory 正文的聚合指标、固定评测结果和当前灰度开关。

### AI Edit

```text
POST /api/ai/generate-edit
POST /api/ai/generate-edit/stream
POST /api/ai/validate-and-fix
```

用于生成普通 patch、流式生成 patch，以及在验证失败后生成修复 patch。

### File Chat

```text
GET    /api/ai/file-chat
POST   /api/ai/file-chat
POST   /api/ai/file-chat/stream
DELETE /api/ai/file-chat
GET    /api/ai/file-chat/histories
DELETE /api/ai/file-chat/histories
DELETE /api/ai/file-chat/messages/:messageId
POST   /api/ai/file-chat/messages/:messageId/branch
```

用于聊天、流式聊天、清空会话、删除历史、删除消息和从消息创建分支对话。

### Task Sessions

```text
GET  /api/task-sessions
GET  /api/task-sessions/:taskSessionId
POST /api/task-sessions/:taskSessionId/commands
```

用于查看任务历史、查看单个任务详情，以及把终端命令结果记录到任务会话中。

### Patch

```text
POST /api/patch/apply
POST /api/patch/reject
```

用于应用或拒绝 AI 生成的 patch。支持按整个 patch 或单个文件处理。

### Checkpoints

```text
GET  /api/checkpoints/:checkpointId
POST /api/checkpoints/rollback
```

用于读取 checkpoint 详情和回滚到修改前状态。

### Git Workflow

```text
GET  /api/git-workflow/status
POST /api/git-workflow/branches
POST /api/git-workflow/commit-message
POST /api/git-workflow/commits
```

用于查看 Git 状态、创建任务分支、生成提交信息和提交指定文件。

## 测试与检查

后端类型检查：

```bash
pnpm --filter @mini-ai-web-editor/server typecheck
```

后端测试：

```bash
pnpm --filter @mini-ai-web-editor/server test
```

后端测试包含 Git 工作流集成测试。该测试会创建临时 Git 仓库，验证创建任务分支、识别文件变更、只提交指定文件，以及提交后工作区恢复干净。

前端类型检查：

```bash
pnpm --dir apps/web exec tsc --noEmit
```

## 项目结构

```text
apps/
  web/       React、Monaco Editor、Diff 审阅、聊天、任务历史、终端和 Git 工作流 UI
  server/    Express API、AI 客户端、工作区工具、patch 处理、命令执行、checkpoint 和 Git workflow
```

本地配置和运行期数据统一收敛到 `.mini-ai`：

```text
.mini-ai/
  AGENTS.md                  项目级通用规则，可按需提交到 Git
  rules/                     项目级路径规则，可按需提交到 Git
  state/                     本地运行时数据，默认应忽略
    web-editor/
      state.json             当前工作区等本地 UI 状态
      chat-store.json        聊天历史
      command-results.json   命令执行结果
    runtime/
      project-memory.json    跨会话项目画像和长期上下文
      checkpoints/           patch 应用前后的回滚快照
      task-sessions/         Agent 任务历史
```

`.mini-ai/state/` 是本地运行时数据，已在 `.gitignore` 中忽略。`.mini-ai/AGENTS.md` 和 `.mini-ai/rules/` 是项目规则，不会被默认忽略，可按团队需要提交。

旧目录 `.mini-ai-web-editor/` 和 `.ai-agent/` 仍作为读取 fallback 保留，避免已有聊天历史、任务会话和 checkpoint 失效；新数据会写入 `.mini-ai/state/`。

## Language Service / LSP

Language Service 默认启用；设置 `LSP_ENABLED=0` 可显式关闭。服务端内置并按文件语言启动以下 Language Server：

- TypeScript / JavaScript：`typescript-language-server`
- Vue：`vue-language-server`（`@vue/language-server`）
- Python：`basedpyright-langserver`、`pyright-langserver` 或 `pylsp`

发现顺序为“工作区本地依赖 → Web IDE 服务端内置依赖 → 系统 PATH”。工作区可安装并固定自己的 Node Language Server 版本；未安装时会直接使用 Web IDE 内置的 `typescript-language-server`、`@vue/language-server` 或 `basedpyright`，不会污染用户项目，也不需要联网下载。项目只发现固定白名单中的命令，不读取项目自定义启动命令或参数。所有来源均不可用时，TS/JS/Vue 会明确降级到现有 Symbol Graph，Python 使用有限文本能力。Language Server 进程在工作区切换、服务退出或长时间空闲时释放。

编辑器支持诊断 Marker、F12 定义、Shift+F12 引用列表、F2 Rename、Hover、工作区符号搜索、LSP Code Action 及“交给 Agent 修复”。Rename 和带 WorkspaceEdit 的 Code Action 只生成待审阅 Patch，不会直接落盘；诊断修复会启动现有 Agent 流程，最终修改仍经过 Patch、审批和 Checkpoint。Agent 侧提供只读诊断、定义、引用、Hover 和符号搜索工具。

Language Server 崩溃后会惰性重启并恢复当前未保存文档；编辑器按文档版本持续刷新诊断。默认不输出 Language Server stderr 内容，如需本地排障可显式设置 `LSP_DEBUG_LOGGING=1`，敏感字段仍会被脱敏且输出有长度限制。

## 当前限制

这个项目仍是一个早期本地编码 Agent，还不是完整的自治开发平台。目前尚未提供：

- Git push、pull request 创建、代码评审评论处理等完整协作流程。
- MCP servers、插件、可复用 skills、hooks 或自定义 subagents。
- 云端后台执行、定时任务或并行 Agent。
- Tree-sitter 或向量搜索；LSP 首批仅覆盖 TypeScript/JavaScript/Vue/Python。
- 浏览器自动化或视觉测试。
- 登录、团队工作区、角色权限或企业审计能力。
- 操作系统级或容器级命令沙箱。
- 多个同时活跃工作区。

当前重点是把本地开发流程做清楚：理解上下文、生成 patch、人工审阅、安全应用、运行验证、失败修复、回滚，以及把确认后的改动整理成可追踪的 Git commit。
## Agent Reliability Updates

The current implementation follows a mainstream AI IDE style reliability loop:

```text
project facts -> tool-backed code search/read -> structured patch -> user review -> validation -> repair patch
```

### Project Inspection

The server can inspect the active workspace before asking the model to choose a fix. `apps/server/src/projectInspector.ts` reads `package.json` and reports:

- package manager, inferred from lockfiles
- package name
- scripts
- dependencies
- devDependencies
- framework hints such as `vue`, `vue-router`, `react`, `vite`, `webpack`, and `typescript`

These project facts are injected into edit and chat prompts as `projectFacts`. This helps the Agent choose APIs that match installed dependency versions. For example, if a project uses `vue-router@3.x`, the Agent should avoid Vue Router 4 APIs such as `createRouter` and `createWebHistory`.

### Project Rules Injection

The server discovers global and project rules before AI chat/edit calls:

- global rules from `~/.mini-ai/AGENTS.md` and `~/.mini-ai/rules/*.md`
- project rules from `.mini-ai/AGENTS.md` and `.mini-ai/rules/*.md`
- legacy rules from `AGENTS.md`, `.cursorrules`, and `.windsurfrules`

Active rules are injected into prompts as `projectRules`. Scoped rules can use frontmatter such as `globs` and `alwaysApply` to match selected files or chat context paths.

### Agent Tools

The Agent tool set now includes:

- `inspectProject()` for package metadata, dependency versions, scripts, and framework hints
- `searchCode(query)` for ripgrep-backed workspace search
- `readFile(filePath)` for bounded workspace file reads

For framework, dependency, import/export, or API-not-found errors, the edit prompt instructs the Agent to use project facts and call `inspectProject()` before deciding which import style or API version is correct.

### Patch Reliability

AI edits are expected to return structured patches:

```json
{
  "summary": "short summary",
  "patches": [
    {
      "filePath": "workspace/relative/path.ts",
      "oldContent": "exact original file content",
      "newContent": "full updated file content",
      "summary": "short file-level summary"
    }
  ],
  "commandsToRun": ["optional validation command"]
}
```

The server validates patch paths, checks that existing file contents still match `oldContent`, removes unchanged file edits, and creates a checkpoint before writing. If the model returns `patches:null` for a request that should produce a code fix, the edit flow retries with stronger context and requires concrete file evidence before accepting that no patch is possible.

### Validation And Repair

`apps/server/src/autoValidationService.ts` can run a validation command through the local command policy. If validation fails, the failure output is summarized and sent back into the edit flow to generate a follow-up repair patch. Repair attempts are bounded to avoid infinite loops.

### Tests

The server test suite includes coverage for the reliability path:

- intent routing for warning/error repair requests
- contextual follow-up edit requests such as "进行修复"
- automatic validation and repair behavior
- patch path normalization
- project inspection of dependency versions and framework hints
- global/project rule discovery and scoped rule activation

Run the checks with:

```bash
pnpm --filter @mini-ai-web-editor/server typecheck
pnpm --filter @mini-ai-web-editor/server test
```


## AI Log Debugging

- Set `AI_FULL_IO_LOGGING=1` to persist each model call into `.mini-ai/state/runtime/ai-logs/`.
- Each JSON log keeps `requestBody`, `responseBody` / `responseText`, `outputText`, `status`, `error`, and `aborted`.
- The server does not write the `Authorization` header, but it does keep the complete model input and output body.
