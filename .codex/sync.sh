#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# sync.sh — build + install the NeurOn Codex CLI (sync:codex protocol).
# POSIX counterpart of sync.ps1:
#   1. esbuild src/neuron-codex.js → dist/neuron-codex.js (repo bundle)
#   2. install to ~/.codex/neuron/:
#        neuron-codex.js (bundle) + launcher/ + neuron-extend.{ps1,sh}
#   3. SHA256 parity: installed bundle must hash identically to the repo bundle
#   4. node --check the installed bundle
#   5. hook mode (plan 004 §4): write ~/.codex/hooks.json (template, POSIX
#      path style), pre-seed the three [hooks.state."…"] trusted_hash blocks
#      + [mcp_servers.neuron] into ~/.codex/config.toml (surgical, idempotent)
# Idempotent. Requires: node, npx (esbuild), sh, awk, sed.
# ─────────────────────────────────────────────────────────────────────────────
set -eu

REPO_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
INSTALL_ROOT=${1:-"$HOME/.codex/neuron"}
DIST="$REPO_DIR/dist/neuron-codex.js"

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

echo "NeurOn sync:codex"
echo "  repo:    $REPO_DIR"
echo "  install: $INSTALL_ROOT"

echo "[1/5] building bundle…"
(
  cd "$REPO_DIR"
  npx --yes esbuild src/neuron-codex.js --bundle --format=esm --platform=node --outfile=dist/neuron-codex.js
)
node --check "$DIST"

echo "[2/5] installing…"
mkdir -p "$INSTALL_ROOT/launcher"
cp -f "$DIST" "$INSTALL_ROOT/neuron-codex.js"
cp -f "$REPO_DIR/launcher/neuron-codex.ps1" "$INSTALL_ROOT/launcher/neuron-codex.ps1"
cp -f "$REPO_DIR/launcher/neuron-codex.sh"  "$INSTALL_ROOT/launcher/neuron-codex.sh"
cp -f "$REPO_DIR/neuron-extend.ps1"         "$INSTALL_ROOT/neuron-extend.ps1"
cp -f "$REPO_DIR/neuron-extend.sh"          "$INSTALL_ROOT/neuron-extend.sh"
cp -f "$REPO_DIR/neuron-done.ps1"           "$INSTALL_ROOT/neuron-done.ps1"
cp -f "$REPO_DIR/neuron-done.sh"            "$INSTALL_ROOT/neuron-done.sh"
chmod +x "$INSTALL_ROOT/launcher/neuron-codex.sh" "$INSTALL_ROOT/neuron-extend.sh" "$INSTALL_ROOT/neuron-done.sh"
# Mark the install dir as ESM so `node neuron-codex.js` never triggers the
# MODULE_TYPELESS_PACKAGE_JSON reparse warning (an ancestor typeless
# package.json, e.g. in the user home, otherwise "wins").
cat > "$INSTALL_ROOT/package.json" <<'EOF'
{
  "name": "neuron-codex",
  "type": "module",
  "private": true
}
EOF

echo "[3/5] verifying SHA256 parity…"
SRC_HASH=$(sha256 "$DIST")
DST_HASH=$(sha256 "$INSTALL_ROOT/neuron-codex.js")
echo "  repo:      $SRC_HASH"
echo "  installed: $DST_HASH"
[ "$SRC_HASH" = "$DST_HASH" ] || { echo "SHA256 parity FAILED" >&2; exit 1; }

echo "[4/5] node --check installed bundle…"
node --check "$INSTALL_ROOT/neuron-codex.js"

echo "[5/5] seeding hooks.json + trust hashes + MCP server…"
CODEX_HOME="$HOME/.codex"
HOOKS_DST="$CODEX_HOME/hooks.json"
CONFIG_TOML="$CODEX_HOME/config.toml"

# 5a. installed hooks.json — template with the real (POSIX) install path.
# The Windows-style "\\neuron-codex.js" join becomes "/neuron-codex.js".
HOOKS_CONTENT=$(sed -e "s|<INSTALL>|$INSTALL_ROOT|g" -e 's|\\\\neuron-codex\.js|/neuron-codex.js|g' "$REPO_DIR/hooks.json")
if [ -f "$HOOKS_DST" ] && [ "$(cat "$HOOKS_DST")" = "$HOOKS_CONTENT" ]; then
  echo "  ok     $HOOKS_DST (unchanged)"
else
  printf '%s\n' "$HOOKS_CONTENT" > "$HOOKS_DST"
  echo "  wrote  $HOOKS_DST"
fi

# 5b. trust hashes (computed from the installed bundle — single source of truth)
hook_hash() { # $1=snake $2=pascal $3=timeout
  node "$INSTALL_ROOT/neuron-codex.js" hook trust "$1" "node $INSTALL_ROOT/neuron-codex.js hook $2" "$3"
}
UP_HASH=$(hook_hash user_prompt_submit UserPromptSubmit 300)
PTU_HASH=$(hook_hash post_tool_use PostToolUse 10)
SS_HASH=$(hook_hash session_start SessionStart 60)
echo "  trust  user_prompt_submit = $UP_HASH"
echo "  trust  post_tool_use      = $PTU_HASH"
echo "  trust  session_start      = $SS_HASH"

# 5c. surgical config.toml splice (POSIX paths => no backslash escaping needed
# in TOML basic strings). value mode: header present -> ensure the value line
# (replace a differing trusted_hash, insert after the header if missing);
# header absent -> append. absent mode: append only when the header is absent.
SPLICE_AWK='
{ lines[NR] = $0 }
END {
  found = 0; changed = 0; skip = 0
  nbody = split(body, bodyArr, "\n")
  for (i = 1; i <= NR; i++) {
    line = lines[i]
    if (!found && line == header) {
      found = 1
      if (mode == "replace") {
        # sync-owned block: rewrite the whole section (header .. next '['
        # line or EOF) with the canonical body when it differs
        j = i + 1
        while (j <= NR && lines[j] !~ /^[[:space:]]*\[/) j++
        sect = ""
        for (k = i; k < j; k++) sect = sect lines[k] "\n"
        canon = header
        for (b = 1; b <= nbody; b++) canon = canon "\n" bodyArr[b]
        canon = canon "\n"
        if (sect != canon) { printf "%s", canon; changed = 1 } else { printf "%s", sect }
        i = j - 1 # skip the consumed section lines
        continue
      }
      print line
      if (mode == "value") {
        handled = 0
        for (j = i + 1; j <= NR; j++) {
          if (lines[j] ~ /^[[:space:]]*\[/) break
          if (lines[j] ~ /^[[:space:]]*trusted_hash[[:space:]]*=/) {
            if (lines[j] != bodyArr[1]) { print bodyArr[1]; changed = 1 } else { print lines[j] }
            skip = j
            handled = 1
            break
          }
        }
        if (!handled) { print bodyArr[1]; changed = 1 }
      }
      continue
    }
    if (i != skip) print line
  }
  if (!found) {
    if (NR > 0 && lines[NR] !~ /^[[:space:]]*$/) print ""
    print header
    for (b = 1; b <= nbody; b++) print bodyArr[b]
    changed = 1
  }
  exit(changed ? 0 : 1)
}
'
run_splice() { # $1=mode $2=header $3=body (newline-joined)
  if [ ! -f "$CONFIG_TOML" ]; then
    echo "  $CONFIG_TOML not found - skipping config seeding" >&2
    return 0
  fi
  if awk -v mode="$1" -v header="$2" -v body="$3" "$SPLICE_AWK" "$CONFIG_TOML" > "$CONFIG_TOML.tmp"; then
    mv "$CONFIG_TOML.tmp" "$CONFIG_TOML"
    echo "  seeded $2"
  else
    rm -f "$CONFIG_TOML.tmp"
    echo "  ok     $2 (already current)"
  fi
}

# All TOML path escaping goes through the bundle's toml-escape subcommand
# (single unit-tested implementation; both platforms share it). Escape the
# FULL value in one pass - never dir-then-append (a lone "\n" in a TOML
# basic string is a NEWLINE escape).
HKEY=$(node "$INSTALL_ROOT/neuron-codex.js" toml-escape "$HOOKS_DST")
[ -n "$HKEY" ] || { echo "  toml-escape failed for $HOOKS_DST" >&2; exit 1; }
run_splice value "[hooks.state.\"$HKEY:user_prompt_submit:0:0\"]" "trusted_hash = \"$UP_HASH\""
run_splice value "[hooks.state.\"$HKEY:post_tool_use:0:0\"]"      "trusted_hash = \"$PTU_HASH\""
run_splice value "[hooks.state.\"$HKEY:session_start:0:0\"]"      "trusted_hash = \"$SS_HASH\""
CLI_PATH_TOML=$(node "$INSTALL_ROOT/neuron-codex.js" toml-escape "$INSTALL_ROOT/neuron-codex.js")
[ -n "$CLI_PATH_TOML" ] || { echo "  toml-escape failed for $INSTALL_ROOT/neuron-codex.js" >&2; exit 1; }
MCP_BODY="command = \"node\"
args = [\"$CLI_PATH_TOML\", \"mcp\"]"
run_splice replace '[mcp_servers.neuron]' "$MCP_BODY"

echo ""
echo "sync:codex OK. Add to ~/.zshrc or ~/.bashrc (once):"
echo '  neuron-codex()  { "$HOME/.codex/neuron/launcher/neuron-codex.sh" "$@"; }'
echo '  neuron-extend() { "$HOME/.codex/neuron/neuron-extend.sh" "$@"; }'
echo "Hook mode (plain codex): hooks.json + trust + MCP server are seeded; gate = UserPromptSubmit."
