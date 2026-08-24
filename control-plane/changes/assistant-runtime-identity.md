# Assistant runtime identity reconciliation

- Persisted Assistant selections now survive llama.cpp quant-name normalization,
  such as configured `UD-Q4_K_XL` becoming discovered `Q4_K_XL`.
- Assistant requests use the exact target-scoped model ID returned by live
  discovery instead of a stale configured identifier.
- Runtime-advertised input and output modalities are preserved when llama.cpp
  nests them in its model architecture record, so Assistant answers reflect the
  deployed model's actual vision, audio, and other modality support.
- The current request's live catalog explicitly supersedes stale catalog claims
  in earlier conversation history.
