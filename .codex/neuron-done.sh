#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# neuron-done — mark the active NeurOn reservation done (NO LLM).
#
# Same as the web UI "I'm Done" button. Picks the latest active lease in
# ~/.codex/neuron/ (override with the CLI's --lease-id). Marks the lease
# file inactive so the keeper stops polling.
#
# Install as a shell function (see .codex/README.md):
#   neuron-done() { "<this script>" "$@"; }
# ─────────────────────────────────────────────────────────────────────────────
set -u

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

# Locate the CLI bundle (same layouts as the launcher: env, repo, installed).
cli=""
for candidate in \
  "${NEURON_CODEX_CLI:-}" \
  "$script_dir/dist/neuron-codex.js" \
  "$script_dir/neuron-codex.js"; do
  if [ -n "$candidate" ] && [ -f "$candidate" ]; then cli="$candidate"; break; fi
done
if [ -z "$cli" ]; then
  echo "NeurOn: could not find neuron-codex.js (set NEURON_CODEX_CLI)" >&2
  exit 1
fi

# Optional lease-id passthrough.
if [ $# -gt 0 ]; then
  exec node "$cli" done --lease-id "$1"
fi

exec node "$cli" done
