# ─────────────────────────────────────────────────────────────────────────────
# neuron-extend [minutes] — manually extend the active NeurOn lease (NO LLM).
#
# Minutes must be an integer 1-720; missing argument → the configured default
# (NEURON_RESERVATION_DURATION_MINUTES, default 2); bad input → usage line.
# The CLI picks the latest active lease in ~/.codex/neuron/ (override with
# the CLI's --lease-id). Additive: the server computes
# expiry = max(now, currentExpiry) + N, so this never shortens a reservation.
#
# Install as a shell function/alias (see .codex/README.md):
#   neuron-extend { & "<this script>" @args }
# ─────────────────────────────────────────────────────────────────────────────
param(
  [Parameter(ValueFromRemainingArguments = $true)] [string[]]$MinutesArgs = @()
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

$minutes = if ($MinutesArgs.Count -gt 0) { $MinutesArgs[0] } else { "" }
if ($minutes -ne "") {
  # 1-720 is at most 3 digits; the length guard keeps [int] overflow-free.
  if ($minutes -match "^\d{1,3}$" -and ([int]$minutes) -ge 1 -and ([int]$minutes) -le 720) {
    node $cli extend --minutes $minutes
    exit $LASTEXITCODE
  }
  Write-Error "NeurOn: usage: neuron-extend [minutes 1-720]"
  exit 2
}

# No argument → the CLI applies the configured default duration.
node $cli extend
exit $LASTEXITCODE
