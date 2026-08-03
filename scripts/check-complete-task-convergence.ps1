$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

function Invoke-VerificationStep {
  param(
    [Parameter(Mandatory = $true)][string]$Title,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )

  Write-Host "`n[Complete Task Convergence] $Title" -ForegroundColor Cyan
  & pnpm.cmd @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Title failed with exit code $LASTEXITCODE"
  }
}

Push-Location $repoRoot
try {
  # Covers policy helpers, runtime convergence, and persisted metrics.
  Invoke-VerificationStep -Title "convergence regression tests" -Arguments @(
    "--dir", "apps/server", "exec", "tsx", "--test",
    "src/agentCompletionPolicy.test.ts",
    "src/agentRuntime.test.ts",
    "src/observability/runMetrics.test.ts"
  )
  Invoke-VerificationStep -Title "server typecheck" -Arguments @("--dir", "apps/server", "typecheck")

  Write-Host "`ncompleteTask convergence verification passed" -ForegroundColor Green
}
finally {
  Pop-Location
}
