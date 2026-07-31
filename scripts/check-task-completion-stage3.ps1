$ErrorActionPreference = "Stop"

pnpm --dir apps/server exec tsx --test `
  src/agentCompletionTools.test.ts `
  src/agentCompletionPolicy.test.ts `
  src/agentBudgetPolicy.test.ts `
  src/agentRuntime.test.ts `
  src/agentTools.test.ts `
  src/prompts.test.ts `
  src/featureFlags.test.ts
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

pnpm --dir apps/server typecheck
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
