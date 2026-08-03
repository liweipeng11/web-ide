$ErrorActionPreference = "Stop"

function Invoke-VerificationStep {
  param(
    [Parameter(Mandatory = $true)][string]$Title,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )

  Write-Host "`n[Task Completion Observability] $Title" -ForegroundColor Cyan
  & pnpm.cmd @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Title failed with exit code $LASTEXITCODE"
  }
}

$testArguments = @("--dir", "apps/server", "exec", "tsx", "--test", "src/observability/runMetrics.test.ts", "src/observability/taskMetrics.test.ts", "src/agentRuntime.test.ts")
Invoke-VerificationStep -Title "Metrics and runtime tests" -Arguments $testArguments
Invoke-VerificationStep -Title "Server typecheck" -Arguments @("--dir", "apps/server", "typecheck")

Write-Host "Task completion observability and resource protection checks passed"
