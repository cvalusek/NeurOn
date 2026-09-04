#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# neuron-extend [minutes] — manually extend the active NeurOn lease (NO LLM).
#
# Minutes must be an integer 1-720; missing argument → the configured default
# (NEURON_RESERVATION_DURATION_MINUTES, default 2); bad input → usage line.
# The CLI picks the latest active lease in ~/.codex/neuron/ (override with
# the CLI's --lease-id). Additive: the server computes
# expiry = max(now, currentExpiry) + N, so this never shortens a reservation.
#
# Install as a shell function (see .codex/README.md):
#   neuron-extend() { "<this script>" "$@"; }
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

minutes="${1:-}"
if [ -n "$minutes" ]; then
  case "$minutes" in
    *[!0-9]*)
      echo "NeurOn: usage: neuron-extend [minutes 1-720]" >&2
      exit 2
      ;;
  esac
  if [ "${#minutes}" -gt 3 ] || [ "$minutes" -lt 1 ] || [ "$minutes" -gt 720 ]; then
    echo "NeurOn: usage: neuron-extend [minutes 1-720]" >&2
    exit 2
  fi
  exec node "$cli" extend --minutes "$minutes"
fi

# No argument → the CLI applies the configured default duration.
exec node "$cli" extend
