$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

function Invoke-VerificationStep {
  param(
    [Parameter(Mandatory = $true)][string]$Title,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )

  Write-Host "`n[Stage 4] $Title" -ForegroundColor Cyan
  & pnpm @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Title failed with exit code $LASTEXITCODE"
  }
}

Push-Location $repoRoot
try {
  # V2 must never depend on the legacy terminal completion marker.
  $markerMatches = & rg -n "__AI_CMD_DONE_|waiting for terminal completion" apps 2>$null
  $markerExitCode = $LASTEXITCODE
  if ($markerExitCode -eq 0) {
    throw "Legacy completion marker detected:`n$markerMatches"
  }
  if ($markerExitCode -ne 1) {
    throw "Legacy marker scan failed with rg exit code $markerExitCode"
  }

  Invoke-VerificationStep -Title "command execution, shell and WebSocket scenarios" -Arguments @("--filter", "@mini-ai-web-editor/server", "test:command-execution")
  Invoke-VerificationStep -Title "rollout, policy, Agent and validation regressions" -Arguments @("--filter", "@mini-ai-web-editor/server", "exec", "tsx", "--test", "src/featureFlags.test.ts", "src/commandPolicy.test.ts", "src/agentCommandTools.test.ts", "src/verifier/verifier.test.ts", "src/autoValidationService.test.ts")
  Invoke-VerificationStep -Title "server typecheck" -Arguments @("--filter", "@mini-ai-web-editor/server", "typecheck")
  Invoke-VerificationStep -Title "web typecheck" -Arguments @("--filter", "@mini-ai-web-editor/web", "typecheck")
  Invoke-VerificationStep -Title "web production build" -Arguments @("--filter", "@mini-ai-web-editor/web", "build")

  Write-Host "`nStage 4 acceptance passed: all 12 required scenario groups are covered." -ForegroundColor Green
} finally {
  Pop-Location
}
