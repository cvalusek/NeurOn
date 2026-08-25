# Keep speed rankings tied to controlled benchmarks

- Stopped deriving prefill, decode, or first-token speed from ordinary LiteLLM
  traffic because provider prefix caching is not described reliably by the
  spend log's response-cache flag.
- Kept traffic polling focused on demand, attribution, popularity, and
  keep-alive.
- Made controlled target-model measurements authoritative when observational
  samples also exist.
