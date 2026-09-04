#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# NeurOn launcher for the Codex CLI (0.93.0) — plan 003 §4.1 (POSIX flavor).
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
#   - success                         → spawn codex (original args) + detached
#                                       keeper (nohup ... & disown) with the
#                                       lease path + codex PID
# ─────────────────────────────────────────────────────────────────────────────
set -u

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

# ── Locate the CLI bundle (env override, repo layout, installed layout) ────
cli=""
for candidate in \
  "${NEURON_CODEX_CLI:-}" \
  "$script_dir/../dist/neuron-codex.js" \
  "$script_dir/../neuron-codex.js"; do
  if [ -n "$candidate" ] && [ -f "$candidate" ]; then cli="$candidate"; break; fi
done
if [ -z "$cli" ]; then
  echo "NeurOn: could not find neuron-codex.js (set NEURON_CODEX_CLI) — launching codex without a reservation" >&2
  exec codex "$@"
fi

codex_home="${NEURON_CODEX_HOME:-$HOME/.codex}"

# Top-level `model = "..."` (double- or single-quoted). Exact key match:
# never matches model_provider / model_catalog_json, and only lines BEFORE
# the first [section] header count (a section-level `model` key can never
# shadow the top-level one).
toml_model() {
  [ -f "$1" ] || return 0
  v=$(sed -nE 's/^[[:space:]]*model[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' "$1" | awk 'BEGIN{f=1} /^\[/{f=0} f' | head -n 1)
  if [ -z "$v" ]; then
    v=$(sed -nE "s/^[[:space:]]*model[[:space:]]*=[[:space:]]*'([^']+)'.*/\1/p" "$1" | awk 'BEGIN{f=1} /^\[/{f=0} f' | head -n 1)
  fi
  printf '%s' "$v"
}

# ── 1. Resolve the launch model ────────────────────────────────────────────
# Scan the FULL arg list: an explicit --model wins regardless of its position
# relative to --profile (matches the CLI's resolveCodexModel precedence).
model=""
profile=""
want_value=""
for a in "$@"; do
  if [ -n "$want_value" ]; then
    if [ "$want_value" = "model" ]; then model="$a"; else profile="$a"; fi
    want_value=""
    continue
  fi
  case "$a" in
    -m | --model) want_value="model" ;;
    --model=*) model=${a#--model=} ;;
    -p | --profile) want_value="profile" ;;
    --profile=*) profile=${a#--profile=} ;;
  esac
done
if [ -z "$model" ] && [ -n "$profile" ]; then
  model=$(toml_model "$codex_home/$profile.config.toml")
fi
if [ -z "$model" ]; then
  model=$(toml_model "$codex_home/config.toml")
fi

# No model resolvable → nothing to gate.
if [ -z "$model" ]; then
  exec codex "$@"
fi

# ── 2. Managed? (bounded, ≤3 s; fail-open when unreachable) ────────────────
if [ -n "$profile" ]; then
  resolved=$(node "$cli" resolve --model "$model" --profile "$profile")
else
  resolved=$(node "$cli" resolve --model "$model")
fi
if [ $? -ne 0 ]; then
  echo "NeurOn: model resolution failed — launching codex without a reservation" >&2
  exec codex "$@"
fi

managed=$(printf '%s' "$resolved" | node -e 'let d="";process.stdin.on("data",(c)=>(d+=c)).on("end",()=>{try{process.stdout.write(JSON.parse(d).managed?"1":"0")}catch(e){process.stdout.write("0")}})')
if [ "$managed" != "1" ]; then
  if printf '%s' "$resolved" | grep -q "control_plane_unreachable"; then
    echo "NeurOn: control plane unreachable — launching codex without a reservation (fail-open)" >&2
  fi
  # Unmanaged model (or provider filtered out) — exec codex immediately.
  exec codex "$@"
fi

# ── 3. Managed → ensure the reservation BEFORE any model traffic ───────────
if [ -n "$profile" ]; then
  lease_file=$(node "$cli" ensure --model "$model" --profile "$profile")
else
  lease_file=$(node "$cli" ensure --model "$model")
fi
ensure_exit=$?
if [ "$ensure_exit" -ne 0 ]; then
  # The CLI already printed `NeurOn: <reason>` on stderr — do NOT launch codex.
  exit "$ensure_exit"
fi
if [ -z "$lease_file" ]; then
  # Fail-open: the control plane was unreachable during ensure (the CLI
  # warned on stderr) — the launcher decides to proceed anyway.
  exec codex "$@"
fi

# ── 4. Success → spawn codex (original args) + detached keeper ─────────────
codex "$@" &
codex_pid=$!

# Stamp the codex PID into the lease file (the keeper also knows it via --pid).
node -e '
  const fs = require("fs");
  const [file, pid] = process.argv.slice(1);
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    j.pid = Number(pid);
    fs.writeFileSync(file, JSON.stringify(j, null, 2) + "\n");
  } catch (e) {
    console.error("NeurOn: could not stamp the codex PID into the lease file");
  }
' "$lease_file" "$codex_pid" || true

# Detached keeper coprocess (plan §4.1: nohup ... & disown).
nohup node "$cli" keeper --lease-file "$lease_file" --pid "$codex_pid" >/dev/null 2>&1 &
keeper_pid=$!
disown "$keeper_pid" 2>/dev/null || true

wait "$codex_pid"
exit $?
