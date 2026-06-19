# Models Too Large for Single-GPU Self-Hosting

Research on models that were investigated but ruled out due
to single-GPU fit limitations.

## Mixtral 8x22B (141B total / 39B active, Mistral)

- Q4_K_M quant: **~85GB** — barely squeezes a 96GB card with zero context
- 202-era model (v0.1) — superseded by newer models
- Strong in English, French, but weak on multilingual and coding vs Qwen3
- **Verdict: Not worth it.** Newer models at smaller scale outperform it.

## Mistral Small 4 119B (119B total / 6.5B active, Mar 25, 2026)

- Best-in-class at its tier but:
- Q4_K_M: **~72GB** — requires multi-GPU for any useful context
- llama.cpp PR #50 was **not merged at time of research** (community
  GGUFs coming)
- Single-GPU is not practical on 96GB
- On DGX Spark with NVFP4 quant: ~60GB, works in single GPU with SGLang/vLLM,
  but this repo uses llama.cpp
- **Verdict: Monitor — add when llama.cpp support stabilizes.**

## Llama 4 Maverick (400B total / 17B active, Meta)

- INT4: ~100GB — **cannot fit on any single GPU** in this hardware class
- Independent evaluations showed Llama 4 significantly underperforms
  Llama 3 on coding benchmarks (Rootly study: 0% vs 90% accuracy)
- Aider Polyglot: 150% (worst in class)
- **Verdict: Not worth it.** Too large and coding quality debatable.

## Llama 4 Scout (109B total / 17B active, Meta)

- INT4: ~100GB — same size problem as Maverick
- Unsloth UD-IQ2_XXS quant: 360GB (still too big for single GPU)
- Coding quality: LiveCodeBench 32.8 vs Maverick's 43.4 (worse sibling)
- **Verdict: Not worth it.** Same size class, worse quality than Maverick.

## Kimi K2 / K2.5 / K2.6 (Moonshot AI, 1T total / 32B active)

- Q4 quant: **~520-588GB** — requires 8x H100 for production, or single
  GPU with 256+ GB RAM and CPU offload (~5-15 tok/s)
- Despite staggering specs, impractical for any single-GPU self-hosting
- **Verdict: Not worth it.** API-only model for this hardware.

## DeepSeek V3 / V4 (671B total, 1.6T total)

- Q4 quant: 400-800GB — similarly impractical
- DeepSeek Coder V2-Lite (16B total / 2.4B active) **is** practical
  but is specialized (code-only, old Gen-1 model) and not in the same
  family as the router's other models
- **Verdict: Not worth it.** Too large; V2-Lite is too old/niche.

## Summary

| Model | Q4 Size | GPUs Needed | Verdict |
|-------|---------|-------------|---------|
| Mixtral 8x22B | ~85GB | 1 (barely) | ❌ Outdated |
| Mistral Small 4 119B | ~72GB | 2 | ⏱️ Wait for llama.cpp |
| Llama 4 Maverick | ~100GB | 2+ | ❌ Too large + coding poor |
| Llama 4 Scout | ~100GB | 2+ | ❌ Worse than Maverick |
| Kimi K2/2.5/2.6 | ~520GB | 8+ H100 | ❌ API-only |
| DeepSeek V3/V4 | 400-800GB | 4+ H100 | ❌ Too large |