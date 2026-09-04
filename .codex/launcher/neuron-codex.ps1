# ─────────────────────────────────────────────────────────────────────────────
# NeurOn launcher for the Codex CLI (0.93.0) — plan 003 §4.1.
#
# Thin wrapper: ALL NeurOn logic lives in the node CLI bundle. This script
# only (1) resolves the launch model (-m/--model arg > --profile <p> →
# ~/.codex/<p>.config.toml `model` > ~/.codex/config.toml `model`),
# (2) asks the CLI whether the model is managed and secures a reservation
# before any model traffic, and (3) spawns codex + the detached keeper.
#
# Behavior:
#   - no model / unmanaged model      → exec codex immediately (no reservation)
#   - control plane unreachable       → warn on stderr, exec codex (fail-open)
#   - ensure failure/timeout (exit 2) → stderr reason, exit non-zero,
#                                       codex is NOT launched
#   - success                         → spawn codex (original args, same
#                                       console) + detached keeper with the
#                                       lease path + codex PID
# ─────────────────────────────────────────────────────────────────────────────
param(
  [Parameter(ValueFromRemainingArguments = $true)] [string[]]$CodexArgs = @()
)

$ErrorActionPreference = "Stop"

function Find-NeuronCli {
  # Env override, then repo layout (../dist), then installed layout (../).
  $candidates = @()
  if ($env:NEURON_CODEX_CLI) { $candidates += $env:NEURON_CODEX_CLI }
  $candidates += (Join-Path $PSScriptRoot "..\dist\neuron-codex.js")
  $candidates += (Join-Path $PSScriptRoot "..\neuron-codex.js")
  foreach ($c in $candidates) {
    if ($c -and (Test-Path -LiteralPath $c)) { return (Resolve-Path -LiteralPath $c).Path }
  }
  return $null
}

function Read-TomlModel([string]$Path) {
  # Top-level `model = "..."` (double- or single-quoted). Exact key match:
  # never matches model_provider / model_catalog_json, and only lines BEFORE
  # the first [section] header count — a section-level `model` key can never
  # shadow the top-level one.
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  $text = (Get-Content -LiteralPath $Path -Raw) -replace ".*\[.*", "`n[", "`n["
  $top = ($text -split "`n\[")[0]
  if ($top -match '(?m)^[ \t]*model[ \t]*=[ \t]*"([^"]+)"') { return $Matches[1] }
  if ($top -match "(?m)^[ \t]*model[ \t]*=[ \t]*'([^']+)'") { return $Matches[1] }
  return $null
}

$cli = Find-NeuronCli
if (-not $cli) {
  Write-Warning "NeurOn: could not find neuron-codex.js (set NEURON_CODEX_CLI) — launching codex without a reservation"
  & codex @CodexArgs
  exit $LASTEXITCODE
}

$codexHome = if ($env:NEURON_CODEX_HOME) { $env:NEURON_CODEX_HOME } else { Join-Path $env:USERPROFILE ".codex" }

# ── 1. Resolve the launch model ────────────────────────────────────────────
# Scan the FULL arg list: an explicit --model wins regardless of its position
# relative to --profile (matches the CLI's resolveCodexModel precedence).
$model = $null
$profile = $null
for ($i = 0; $i -lt $CodexArgs.Count; $i++) {
  $a = $CodexArgs[$i]
  if ($a -eq "-m" -or $a -eq "--model") {
    if ($i + 1 -lt $CodexArgs.Count) { $model = $CodexArgs[$i + 1]; $i++ }
  } elseif ($a -like "--model=*") { $model = $a.Substring(8) }
  elseif ($a -eq "--profile" -or $a -eq "-p") {
    if ($i + 1 -lt $CodexArgs.Count) { $profile = $CodexArgs[$i + 1]; $i++ }
  } elseif ($a -like "--profile=*") { $profile = $a.Substring(10) }
}
if (-not $model -and $profile) {
  $model = Read-TomlModel (Join-Path $codexHome "$profile.config.toml")
}
if (-not $model) {
  $model = Read-TomlModel (Join-Path $codexHome "config.toml")
}

# No model resolvable → nothing to gate.
if (-not $model) {
  & codex @CodexArgs
  exit $LASTEXITCODE
}

# Fail-open when node is missing from PATH: matches the POSIX launcher, which
# execs codex directly. Without this, `& node …` below throws a
# CommandNotFoundException and, under $ErrorActionPreference = "Stop", kills
# the launcher with a raw PowerShell error.
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Warning "NeurOn: node not found in PATH — skipping reservation gate, launching codex directly"
  & codex @CodexArgs
  exit $LASTEXITCODE
}

# ── 2. Managed? (bounded, ≤3 s; fail-open when unreachable) ────────────────
$resolveArgs = @($cli, "resolve", "--model", $model)
if ($profile) { $resolveArgs += @("--profile", $profile) }
$resolvedJson = & node @resolveArgs
$resolveExit = $LASTEXITCODE

if ($resolveExit -ne 0) {
  Write-Warning "NeurOn: model resolution failed (exit $resolveExit) — launching codex without a reservation"
  & codex @CodexArgs
  exit $LASTEXITCODE
}
$resolved = ($resolvedJson -join "`n") | ConvertFrom-Json
if (-not $resolved.managed) {
  if ("$($resolved.reason)" -like "control_plane_unreachable*") {
    Write-Warning "NeurOn: control plane unreachable — launching codex without a reservation (fail-open)"
  }
  # Unmanaged model (or provider filtered out) — exec codex immediately.
  & codex @CodexArgs
  exit $LASTEXITCODE
}

# ── 3. Managed → ensure the reservation BEFORE any model traffic ───────────
$ensureArgs = @($cli, "ensure", "--model", $model)
if ($profile) { $ensureArgs += @("--profile", $profile) }
$ensureOut = & node @ensureArgs
$ensureExit = $LASTEXITCODE

if ($ensureExit -ne 0) {
  # The CLI already printed `NeurOn: <reason>` on stderr — do NOT launch codex.
  exit $ensureExit
}
$leaseFile = ($ensureOut -join "`n") -replace "^\s+|\s+$", ""
if (-not $leaseFile) {
  # Fail-open: the control plane was unreachable during ensure (the CLI
  # warned on stderr) — the launcher decides to proceed anyway.
  & codex @CodexArgs
  exit $LASTEXITCODE
}

# ── 4. Success → spawn codex (original args) + detached keeper ─────────────
# Start-Process cannot CreateProcess an npm .ps1 shim ("%1 is not a valid
# Win32 application"), so resolve the real executable first:
#   - .ps1 shim → run its node entry point directly (mirrors the shim layout)
#   - .cmd shim → run via cmd /c
#   - .exe      → run directly
$codexCmd = Get-Command codex -ErrorAction Stop
$codexFile = $codexCmd.Source
$spawnFile = $codexFile
$spawnBase = @()
if ($codexFile -and $codexFile -like "*.ps1") {
  $shimDir = Split-Path -Parent $codexFile
  $codexJs = Join-Path $shimDir "node_modules\@openai\codex\bin\codex.js"
  if (Test-Path -LiteralPath $codexJs) {
    $nodeExe = Join-Path $shimDir "node.exe"
    if (-not (Test-Path -LiteralPath $nodeExe)) {
      $nodeExe = (Get-Command node -ErrorAction Stop).Source
    }
    $spawnFile = $nodeExe
    $spawnBase = @($codexJs)
  } else {
    # Non-npm .ps1 shim — run it in its own pwsh host (same console).
    $spawnFile = Join-Path $PSHome "pwsh.exe"
    $spawnBase = @("-NoProfile", "-File", $codexFile)
  }
} elseif ($codexFile -and ($codexFile -like "*.cmd" -or $codexFile -like "*.bat")) {
  $spawnFile = $env:ComSpec
  $spawnBase = @("/d", "/c", $codexFile)
}
# Spawn via .NET ProcessStartInfo.ArgumentList: Start-Process -ArgumentList
# joins args without quoting paths that contain spaces ("C:\Program Files\…"),
# which breaks node's entry-point path. ArgumentList quotes each element
# correctly and needs no shell to interpret. The child inherits the parent's
# console and stdin (UseShellExecute=false), so the terminal behaves exactly
# like `codex ...`.
try {
  $spawnInfo = New-Object System.Diagnostics.ProcessStartInfo
  $spawnInfo.FileName = $spawnFile
  $spawnInfo.UseShellExecute = $false
  foreach ($a in (@($spawnBase) + $CodexArgs)) {
    $spawnInfo.ArgumentList.Add([string]$a)
  }
  $codexProc = [System.Diagnostics.Process]::Start($spawnInfo)
} catch {
  Write-Error "NeurOn: failed to launch codex: $($_.Exception.Message)"
  exit 1
}
if (-not $codexProc) {
  Write-Error "NeurOn: failed to launch codex"
  exit 1
}

# Stamp the codex PID into the lease file (the keeper also knows it via --pid).
try {
  $lease = Get-Content -LiteralPath $leaseFile -Raw | ConvertFrom-Json
  $lease.pid = $codexProc.Id
  $lease | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $leaseFile -Encoding utf8
} catch {
  Write-Warning "NeurOn: could not stamp the codex PID into the lease file"
}

# Detached keeper coprocess (hidden, own process group, streams detached so
# it never holds the console). ArgumentList quoting as above.
try {
  $keeperInfo = New-Object System.Diagnostics.ProcessStartInfo
  $keeperInfo.FileName = (Get-Command node -ErrorAction Stop).Source
  $keeperInfo.UseShellExecute = $false
  $keeperInfo.CreateNoWindow = $true
  $keeperInfo.RedirectStandardOutput = $true
  $keeperInfo.RedirectStandardError = $true
  foreach ($a in @($cli, "keeper", "--lease-file", $leaseFile, "--pid", "$($codexProc.Id)")) {
    $keeperInfo.ArgumentList.Add([string]$a)
  }
  [System.Diagnostics.Process]::Start($keeperInfo) | Out-Null
} catch {
  Write-Warning "NeurOn: could not start the keeper coprocess: $($_.Exception.Message)"
}

# Stay attached to codex so the terminal behaves exactly like `codex ...`.
$codexProc.WaitForExit()
exit $codexProc.ExitCode
