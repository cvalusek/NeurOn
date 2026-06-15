#!/bin/bash
set -euo pipefail

MODELS_DIR="/models"
mkdir -p "$MODELS_DIR"

# download <hf-repo> [extra hf-download args...]
# Skips download if the destination dir already has files (e.g. mounted volume cache).
download() {
  local repo="$1"
  shift
  local dest="$MODELS_DIR/$repo"

  if [ -d "$dest" ] && [ -n "$(find "$dest" -maxdepth 1 -name '*.gguf' -print -quit 2>/dev/null)" ]; then
    echo "[download-models] $repo: gguf already present in $dest, skipping download"
    return
  fi

  echo "[download-models] $repo: downloading to $dest"
  mkdir -p "$dest"
  hf download "$repo" --local-dir "$dest" "$@"
}

download unsloth/gemma-4-26B-A4B-it-qat-GGUF \
  --include "*UD-Q4_K_XL*" \
  --include "*mtp-gemma*"

download unsloth/gemma-4-E2B-it-qat-GGUF \
  --include "*UD-Q4_K_XL*" \
  --include "*mtp-gemma*"

download unsloth/gemma-4-E4B-it-qat-GGUF \
  --include "*UD-Q4_K_XL*" \
  --include "*mtp-gemma*"

download unsloth/Qwen3.6-35B-A3B-MTP-GGUF \
  --include "*UD-Q4_K_XL*"

download unsloth/GLM-4.7-Flash-REAP-23B-A3B-GGUF \
  --include "*UD-Q4_K_XL*"