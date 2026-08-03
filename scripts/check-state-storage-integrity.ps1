$ErrorActionPreference = "Stop"

pnpm --dir apps/server exec tsx --test `
  src/stateFileStorage.test.ts `
  src/chatStore.test.ts `
  src/commandResults.test.ts `
  src/commandExecution/commandExecutionStore.test.ts `
  src/workspaceStore.test.ts `
  src/taskSessionStore.test.ts `
  src/observability/taskMetrics.test.ts

if ($LASTEXITCODE -ne 0) { throw "State storage tests failed" }

pnpm --dir apps/server typecheck
if ($LASTEXITCODE -ne 0) { throw "Server typecheck failed" }

$stateRoot = Join-Path $PSScriptRoot "..\.mini-ai\state\web-editor"
$stateFiles = @(
  "chat-store.json",
  "command-executions.json",
  "command-results.json"
)

foreach ($relativePath in $stateFiles) {
  $stateFile = Join-Path $stateRoot $relativePath
  if (Test-Path -LiteralPath $stateFile) {
    try {
      $utf8 = New-Object System.Text.UTF8Encoding($false, $true)
      $raw = $utf8.GetString([System.IO.File]::ReadAllBytes($stateFile))
      $raw | ConvertFrom-Json | Out-Null
    }
    catch {
      throw "State file is not valid UTF-8 JSON and was preserved: $stateFile"
    }
  }
}

Write-Host "Stage 5 state storage integrity verification passed"
