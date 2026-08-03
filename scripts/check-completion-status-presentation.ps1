$ErrorActionPreference = "Stop"

function Invoke-VerificationStep {
  param(
    [Parameter(Mandatory = $true)][string]$Title,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )

  Write-Host "`n[Completion Presentation] $Title" -ForegroundColor Cyan
  & pnpm.cmd @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Title failed with exit code $LASTEXITCODE"
  }
}

# Verify the server rejection contract and frontend presentation together.
$runtimeTestArguments = @("--dir", "apps/server", "exec", "tsx", "--test", "src/agentCompletionPolicy.test.ts", "src/agentRuntime.test.ts")
Invoke-VerificationStep -Title "Server policy and runtime tests" -Arguments $runtimeTestArguments
Invoke-VerificationStep -Title "Server typecheck" -Arguments @("--dir", "apps/server", "typecheck")
Invoke-VerificationStep -Title "Web typecheck" -Arguments @("--dir", "apps/web", "typecheck")
Invoke-VerificationStep -Title "Web production build" -Arguments @("--dir", "apps/web", "build")

Write-Host "Completion status classification and presentation checks passed"
