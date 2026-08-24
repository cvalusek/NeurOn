# Discover runtime model IDs before warmup

- NeurOn now refreshes a healthy target's live model catalog before warming a
  reserved model, preventing llama.cpp quant-name normalization from blocking
  discovery.
- Warmup and direct speed benchmarks now use the target-scoped discovered model
  ID, with the configured backend ID as the fallback.
- Stale model metadata from an older runtime-discovery identifier no longer
  prevents NeurOn from restarting; the durable row is retained but excluded
  until its model is selectable again.
