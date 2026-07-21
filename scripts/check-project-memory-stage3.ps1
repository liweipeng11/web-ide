$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root

try {
    # 验证相关性评分、动态 Token 预算和所有模型入口的统一召回行为。
    pnpm --filter @mini-ai-web-editor/server exec tsx --test src/projectMemory/memoryRetrievalService.test.ts src/projectMemory/memoryScoring.test.ts src/projectMemory/memoryPromptBudget.test.ts src/projectMemory/projectMemoryIntegration.test.ts src/agentRuntime.test.ts src/aiClient.test.ts

    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }

    pnpm --filter @mini-ai-web-editor/server typecheck
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
