# Guided model selection

The profile builder now shows target hourly prices and can filter target-model
deployments by minimum context, maximum hourly cost, domain strength, and
measured quantization quality retention. A synchronized quality/speed/cost
triangle, quick wizard, and category recommendations rank the remaining
choices without treating missing measurements as facts.

Operators can load a private, provenance-aware selection catalog and can
optionally enable a read-only AI profile advisor. Normal LiteLLM traffic adds
privacy-safe local prefill, first-token, and decode observations; NeurOn never
sends benchmark traffic merely to populate the selector.
