param(
    [Parameter(Mandatory = $true)][string]$InputPath,
    [string]$OutputPath
)

$repoRoot = Split-Path -Parent $PSScriptRoot
$serverRoot = Join-Path $repoRoot "apps/server"
$tsxPath = Join-Path $serverRoot "node_modules/.bin/tsx.cmd"
$cliPath = Join-Path $serverRoot "src/langgraph/rollout/rolloutObservationCli.ts"
$resolvedInput = if ([IO.Path]::IsPathRooted($InputPath)) { $InputPath } else { Join-Path $repoRoot $InputPath }
$resolvedInput = [IO.Path]::GetFullPath($resolvedInput)
$resolvedOutput = ""
if ($OutputPath) {
    $resolvedOutput = if ([IO.Path]::IsPathRooted($OutputPath)) { $OutputPath } else { Join-Path $repoRoot $OutputPath }
    $resolvedOutput = [IO.Path]::GetFullPath($resolvedOutput)
}

if (-not (Test-Path -LiteralPath $tsxPath -PathType Leaf)) {
    throw "tsx is unavailable; run pnpm install before evaluating stage 9 observations"
}

& $tsxPath $cliPath $resolvedInput $resolvedOutput
$commandExit = $LASTEXITCODE
exit $commandExit
