# ─────────────────────────────────────────────────────────────────────────────
# neuron-done — mark the active NeurOn reservation done (NO LLM).
#
# Same as the web UI "I'm Done" button. Picks the latest active lease in
# ~/.codex/neuron/ (override with the CLI's --lease-id). Marks the lease
# file inactive so the keeper stops polling.
#
# Install as a shell function/alias (see .codex/README.md):
#   neuron-done { & "<this script>" @args }
# ─────────────────────────────────────────────────────────────────────────────
param(
  [Parameter(ValueFromRemainingArguments = $true)] [string[]]$LeaseArgs = @()
)

$ErrorActionPreference = "Stop"

# Locate the CLI bundle (same layouts as the launcher: env, repo, installed).
$cli = $null
$candidates = @()
if ($env:NEURON_CODEX_CLI) { $candidates += $env:NEURON_CODEX_CLI }
$candidates += (Join-Path $PSScriptRoot "dist\neuron-codex.js")
$candidates += (Join-Path $PSScriptRoot "neuron-codex.js")
foreach ($c in $candidates) {
  if ($c -and (Test-Path -LiteralPath $c)) { $cli = (Resolve-Path -LiteralPath $c).Path; break }
}
if (-not $cli) {
  Write-Error "NeurOn: could not find neuron-codex.js (set NEURON_CODEX_CLI)"
  exit 1
}

# Optional --lease-id passthrough.
$leaseIdArgs = @()
if ($LeaseArgs.Count -gt 0) {
  $leaseIdArgs = @("--lease-id", $LeaseArgs[0])
}

node $cli done @leaseIdArgs
exit $LASTEXITCODE
