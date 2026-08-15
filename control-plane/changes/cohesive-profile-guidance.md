# Cohesive profile guidance and Assistant configuration

- **Admin > Assistant** now owns the profile Assistant's target, model,
  reservation duration, keep-alive, and response timeout in an independent
  durable record. Schema version 4 safely moves a legacy target-embedded
  selection into that record without rewriting model configuration.
- Editing a target now rehydrates its durable discovery snapshot, preventing
  target or Assistant administration from dropping discovered models on that
  or other targets.
- The Good/Fast/Cheap triangle is the profile wizard. It continuously reranks
  cards and shows each deployment's fit and data coverage, while context,
  hourly cost, hosting shape, and advertised technical capabilities remain
  strict requirements.
- Model intelligence, scored strengths, and quantization facts are distinct
  from exact target-model context and speed. Active discovery recognizes
  advertised technical flags, and operator speed benchmarks now use a
  cache-resistant 50K-token-class prompt after a discarded warmup.
