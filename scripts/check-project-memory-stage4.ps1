$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root

try {
    # 验证来源有效性、分支隔离、冲突替代和生命周期流转
    pnpm --filter @mini-ai-web-editor/server exec tsx --test `
        src/projectMemory/memoryValidationService.test.ts `
        src/projectMemory/memoryLifecycleService.test.ts `
        src/projectMemory/memoryConflictService.test.ts `
        src/projectMemory/projectMemoryService.test.ts

    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }

    pnpm --filter @mini-ai-web-editor/server typecheck
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
