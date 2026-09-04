# ─────────────────────────────────────────────────────────────────────────────
# sync.ps1 — build + install the NeurOn Codex CLI (sync:codex protocol).
#
#   1. esbuild src/neuron-codex.js → dist/neuron-codex.js (repo bundle)
#   2. install to ~/.codex/neuron/:
#        neuron-codex.js (bundle) + launcher/ + neuron-extend.{ps1,sh}
#   3. SHA256 parity: installed bundle must hash identically to the repo
#      bundle (the copy-install sync protocol, plan 003 §3.2)
#   4. node --check the installed bundle
#   5. hook mode (plan 004 §4): write ~/.codex/hooks.json (template with the
#      real install path), pre-seed the three [hooks.state."…"] trusted_hash
#      blocks + the [mcp_servers.neuron] block into ~/.codex/config.toml —
#      surgical (only the target section bytes change) and idempotent
#      (a second run is a no-op).
#
# Idempotent. Requires: node, npx (esbuild), PowerShell 7.
# ─────────────────────────────────────────────────────────────────────────────
param(
  # Override the install root (default: $env:USERPROFILE\.codex\neuron)
  [string]$InstallRoot = ""
)

$ErrorActionPreference = "Stop"
$repoDir = $PSScriptRoot
$dist = Join-Path $repoDir "dist\neuron-codex.js"
$installRoot = if ($InstallRoot) { $InstallRoot } else { Join-Path $env:USERPROFILE ".codex\neuron" }

Write-Host "NeurOn sync:codex"
Write-Host "  repo:    $repoDir"
Write-Host "  install: $installRoot"

# ── 1. build ─────────────────────────────────────────────────────────────────
Write-Host "[1/5] building bundle…"
Push-Location $repoDir
try {
  npx --yes esbuild src/neuron-codex.js --bundle --format=esm --platform=node --outfile=dist/neuron-codex.js
  if ($LASTEXITCODE -ne 0) { throw "esbuild failed (exit $LASTEXITCODE)" }
  node --check $dist
  if ($LASTEXITCODE -ne 0) { throw "node --check failed on repo bundle" }
} finally {
  Pop-Location
}

# ── 2. install ───────────────────────────────────────────────────────────────
Write-Host "[2/5] installing…"
New-Item -ItemType Directory -Force -Path (Join-Path $installRoot "launcher") | Out-Null
Copy-Item -LiteralPath $dist -Destination (Join-Path $installRoot "neuron-codex.js") -Force
Copy-Item -LiteralPath (Join-Path $repoDir "launcher\neuron-codex.ps1") -Destination (Join-Path $installRoot "launcher\neuron-codex.ps1") -Force
Copy-Item -LiteralPath (Join-Path $repoDir "launcher\neuron-codex.sh") -Destination (Join-Path $installRoot "launcher\neuron-codex.sh") -Force
Copy-Item -LiteralPath (Join-Path $repoDir "neuron-extend.ps1") -Destination (Join-Path $installRoot "neuron-extend.ps1") -Force
Copy-Item -LiteralPath (Join-Path $repoDir "neuron-extend.sh") -Destination (Join-Path $installRoot "neuron-extend.sh") -Force
Copy-Item -LiteralPath (Join-Path $repoDir "neuron-done.ps1") -Destination (Join-Path $installRoot "neuron-done.ps1") -Force
Copy-Item -LiteralPath (Join-Path $repoDir "neuron-done.sh") -Destination (Join-Path $installRoot "neuron-done.sh") -Force
# Mark the install dir as ESM so `node neuron-codex.js` never triggers the
# MODULE_TYPELESS_PACKAGE_JSON reparse warning (an ancestor typeless
# package.json, e.g. in the user home, otherwise "wins").
Set-Content -LiteralPath (Join-Path $installRoot "package.json") -Value '{
  "name": "neuron-codex",
  "type": "module",
  "private": true
}' -Encoding utf8

# ── 3. SHA256 parity ─────────────────────────────────────────────────────────
Write-Host "[3/5] verifying SHA256 parity…"
$srcHash = (Get-FileHash -LiteralPath $dist -Algorithm SHA256).Hash
$dstFile = Join-Path $installRoot "neuron-codex.js"
$dstHash = (Get-FileHash -LiteralPath $dstFile -Algorithm SHA256).Hash
Write-Host "  repo:      $srcHash"
Write-Host "  installed: $dstHash"
if ($srcHash -ne $dstHash) { throw "SHA256 parity FAILED" }

# ── 4. sanity ────────────────────────────────────────────────────────────────
Write-Host "[4/5] node --check installed bundle…"
node --check $dstFile
if ($LASTEXITCODE -ne 0) { throw "node --check failed on installed bundle" }

# ── 5. hook mode (plan 004 §4) ──────────────────────────────────────────────
# 5a. ~/.codex/hooks.json from the template (real install path, JSON-escaped)
# 5b. [hooks.state."…"] trusted_hash blocks pre-seeded — computed by the
#     INSTALLED bundle (single source of truth for the 0.151.0 normalization)
# 5c. [mcp_servers.neuron] rewritten to canonical content (sync-owned block);
#     hooks.state blocks get their trusted_hash line replaced
# Surgical: only the target section bytes change; every other byte of
# config.toml is preserved (no EOL normalization). Idempotent: a second run
# is a no-op (zero diff). All TOML path escaping goes through the bundle's
# `toml-escape` subcommand (single unit-tested implementation) - NEVER
# escape directory-by-directory and append a raw filename: a lone "\n" in a
# TOML basic string is a NEWLINE escape (regression: MODULE_NOT_FOUND with a
# literal LF in the path).
Write-Host "[5/5] seeding hooks.json + trust hashes + MCP server…"
$codexHome = Join-Path $env:USERPROFILE ".codex"
$hooksDst = Join-Path $codexHome "hooks.json"
$configToml = Join-Path $codexHome "config.toml"

# 5a. installed hooks.json
$template = Get-Content -LiteralPath (Join-Path $repoDir "hooks.json") -Raw
$jsonInstall = $installRoot -replace '\\', '\\'
$hooksContent = $template.Replace('<INSTALL>', $jsonInstall)
$prevHooks = $null
if (Test-Path -LiteralPath $hooksDst) { $prevHooks = Get-Content -LiteralPath $hooksDst -Raw }
if ($null -eq $prevHooks -or $prevHooks.TrimEnd() -cne $hooksContent.TrimEnd()) {
  Set-Content -LiteralPath $hooksDst -Value $hooksContent -Encoding utf8NoBOM
  Write-Host "  wrote  $hooksDst"
} else {
  Write-Host "  ok     $hooksDst (unchanged)"
}

# 5b. trust hashes (computed from the installed bundle)
$hookDefs = @(
  @{ snake = 'user_prompt_submit'; pascal = 'UserPromptSubmit'; timeout = 300 },
  @{ snake = 'post_tool_use';      pascal = 'PostToolUse';      timeout = 10 },
  @{ snake = 'session_start';      pascal = 'SessionStart';     timeout = 60 }
)
$hashes = @{}
foreach ($h in $hookDefs) {
  $cmd = "node $installRoot\neuron-codex.js hook $($h.pascal)"
  $out = (& node (Join-Path $installRoot 'neuron-codex.js') hook trust $h.snake $cmd $h.timeout | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $out -notlike 'sha256:*') {
    throw "trust hash computation failed for $($h.snake): $out"
  }
  $hashes[$h.snake] = $out
  Write-Host "  trust  $($h.snake) = $out"
}

# 5c. surgical config.toml splice
function Splice-ConfigSection {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$Header,
    [Parameter(Mandatory)][string[]]$Body,
    [ValidateSet('value', 'absent', 'replace')][string]$Mode
  )
  if (-not (Test-Path -LiteralPath $Path)) {
    Write-Warning "  $Path not found - skipping config seeding (use /hooks TUI trust or --dangerously-bypass-hook-trust)"
    return
  }
  $raw = [System.IO.File]::ReadAllText($Path)
  $crlf = [regex]::Matches($raw, "`r`n").Count
  $lf = [regex]::Matches($raw, "(?<!`r)`n").Count
  $eol = if ($crlf -ge $lf) { "`r`n" } else { "`n" }

  $idx = $raw.IndexOf($Header, [System.StringComparison]::Ordinal)
  $newRaw = $raw
  if ($idx -lt 0) {
    $sep = if ($raw.Length -eq 0 -or $raw.EndsWith("`n")) { $eol } else { $eol + $eol }
    $newRaw = $raw + $sep + $Header + $eol + ($Body -join $eol) + $eol
  } elseif ($Mode -eq 'absent') {
    return # section exists - never overwrite user edits
  } elseif ($Mode -eq 'replace') {
    # 'replace' mode (sync-owned block): rewrite the whole section
    # (header line .. next '[' line or EOF) with the canonical body when it
    # differs; no-op when identical (idempotent). Used for
    # [mcp_servers.neuron], which sync fully owns (both lines).
    $m = [regex]::Match($raw.Substring($idx + $Header.Length), '(?m)^[ \t]*\[')
    $sectionEnd = if ($m.Success) { $idx + $Header.Length + $m.Index } else { $raw.Length }
    $existing = $raw.Substring($idx, $sectionEnd - $idx)
    $canonical = $Header + $eol + ($Body -join $eol) + $eol
    if ($existing -cne $canonical) {
      $newRaw = $raw.Substring(0, $idx) + $canonical + $raw.Substring($sectionEnd)
    }
  } else {
    # 'value' mode: locate the section (header line .. next '[' line or EOF)
    # and replace the whole trusted_hash LINE with $Body[0] (which IS the
    # full line 'trusted_hash = "sha256:..."'). Line-level Replace avoids
    # Group.Offset coordinate pitfalls (offsets are input-relative, not
    # match-relative, in .NET).
    $sectionStart = $idx + $Header.Length
    $m = [regex]::Match($raw.Substring($sectionStart), '(?m)^[ \t]*\[')
    $sectionEnd = if ($m.Success) { $sectionStart + $m.Index } else { $raw.Length }
    $section = $raw.Substring($sectionStart, $sectionEnd - $sectionStart)
    if ([regex]::IsMatch($section, '(?m)^[ \t]*trusted_hash[ \t]*=')) {
      # trusted_hash line present: replace the whole line with $Body[0].
      # Idempotent: if the value already matches, $newRaw stays == $raw.
      # Safe as a .NET replacement string: values are sha256:<hex> (no '$').
      $newSection = [regex]::Replace($section, '(?m)^[ \t]*trusted_hash[ \t]*=[ \t]*"[^"]*"', $Body[0], 1)
      $newRaw = $raw.Substring(0, $sectionStart) + $newSection + $raw.Substring($sectionEnd)
    } else {
      # section exists but has no trusted_hash line yet: insert after header
      $nl = $raw.IndexOf("`n", $sectionStart)
      $insertAt = if ($nl -ge 0) { $nl + 1 } else { $raw.Length }
      $newRaw = $raw.Substring(0, $insertAt) + $Body[0] + $eol + $raw.Substring($insertAt)
    }
  }
  if ($newRaw -cne $raw) {
    [System.IO.File]::WriteAllText($Path, $newRaw)
    Write-Host "  seeded $Header"
  } else {
    Write-Host "  ok     $Header (already current)"
  }
}

# NOTE: pre-build every string BEFORE putting it in an @() array - inside
# @(...), PowerShell's comma operator binds tighter than '+', which would
# silently split a concatenated literal into separate array elements.
# NOTE: every full path is escaped in ONE pass via the bundle's toml-escape
# subcommand (unit-tested in .opencode/test/neuron-codex.test.js).
$cliPathFull = Join-Path $installRoot 'neuron-codex.js'
function Invoke-TomlEscape {
  param([Parameter(Mandatory)][string]$Value)
  $escaped = (& node $cliPathFull toml-escape $Value | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrEmpty($escaped) -or $escaped -match '[\r\n]') {
    throw "toml-escape failed for <$Value> (exit $LASTEXITCODE)"
  }
  return $escaped
}
$keyPath = Invoke-TomlEscape $hooksDst
foreach ($h in $hookDefs) {
  $header = '[hooks.state."' + $keyPath + ':' + $h.snake + ':0:0"]'
  $trustLine = 'trusted_hash = "' + $hashes[$h.snake] + '"'
  Splice-ConfigSection -Path $configToml -Header $header -Body @($trustLine) -Mode value
}
$cliPathToml = Invoke-TomlEscape $cliPathFull
$mcpArgsLine = 'args = ["' + $cliPathToml + '", "mcp"]'
$mcpBody = @(
  'command = "node"',
  $mcpArgsLine
)
Splice-ConfigSection -Path $configToml -Header '[mcp_servers.neuron]' -Body $mcpBody -Mode replace

Write-Host ""
Write-Host "sync:codex OK. Install alias (once), in your PowerShell profile:"
Write-Host '  function neuron-codex  { & "$env:USERPROFILE\.codex\neuron\launcher\neuron-codex.ps1" @args }'
Write-Host '  function neuron-extend { & "$env:USERPROFILE\.codex\neuron\neuron-extend.ps1" @args }'
Write-Host "Hook mode (plain `codex`): hooks.json + trust + MCP server are seeded; gate = UserPromptSubmit."
