$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

function Invoke-VerificationStep {
  param(
    [Parameter(Mandatory = $true)][string]$Title,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )

  Write-Host "`n[Task Completion Evidence] $Title" -ForegroundColor Cyan
  & pnpm.cmd @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Title failed with exit code $LASTEXITCODE"
  }
}

Push-Location $repoRoot
try {
  Invoke-VerificationStep -Title "approval evidence regression tests" -Arguments @(
    "--dir", "apps/server", "exec", "tsx", "--test",
    "src/agentRuntime.test.ts",
    "src/taskSessionStore.test.ts",
    "src/acceptance/agentTaskCompletionAcceptance.test.ts"
  )
  Invoke-VerificationStep -Title "server typecheck" -Arguments @("--dir", "apps/server", "typecheck")

  Write-Host "`nTask completion evidence persistence verification passed." -ForegroundColor Green
}
finally {
  Pop-Location
}
