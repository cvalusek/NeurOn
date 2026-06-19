# Research Index

Model selection research for `llm-hosting`, as of June 2026.

## Quick Reference

### Comparison Matrix (20-35B models that fit on 96GB)

| Model | Total/Active | VRAM (Q4) | SWE-Bench | τ²-Bench | Math (AIME) Context | MTP | GGUF |
|-------|-------------|-----------|-----------|----------|---------------------|-----|------|
| Qwen3.6-35B-A3B | 35B/3B | 22GB | 70.9 | 50.0 | 92.7 | 262K | ✅ | ✅ |
| Qwen3.6-27B | 27B/27B | 17GB | 77.2 | 57.0 | 94.1 | 156K | ✅ | ✅ |
| GLM-4.7-Flash | 30B/3B | 24GB | 59.0 | 79.5 | 91.0 | 200K | ❌ | ✅ (REAP) |
| Gemma 4-26B-A4B | 26B/3.8B | 14GB | 32.0 | 68.0 | 88.0 | 256K | ✅ | ✅ |
| Nemotron-3-Nano 30B | 31B/3B | 24GB | 88.0 | 49.0 | 99.0 | 256K | ❌ | ✅ |
| Cascade 2 30B-A3B | 30B/3B | 18GB | 87.0 | 83.5 | 92.4 | 256K | ❌ | ✅ |
| Qwen3-Coder-30B-A3B | 30B/3.3B | 17.7GB | ~64.0 | ? | ? | 262K | ✅ | ✅ |

### Best for each category

- **Code quality**: Qwen3.6-27B (77.2 SWE-bench)
- **Code speed**: Qwen3.6-35B-A3B (3-4x faster than 27B)
- **Tool use**: GLM-4.7-Flash (79.5 τ²-Bench)
- **Math**: Nemotron 3-Flash (1.88) or Nemotron (99.2% AIME)
- **Long context**: Nemotron-3-Nano-30B (1M native)
- **Chat**: Gemma 4-26B-A4B (1400 Elo on Arena)

### Key takeaways

1. **Qwen3.6-27B dense beats everything** on benchmarks but is 3-4x slower. Add it to 96gb for quality users.
2. **GLM-4.7-Flash needs MTP enabled** (community GGUFs exist, `spec-draft-n-max=2`).
3. **No MTP for Nemotron-3-Nano-30B** — pure math specialist, no speculative decoding.
4. **8gb/12gb need small models**: Qwen3-4B for 8gb, Qwen3-8B for 12gb.
5. **Drop E2B/E4B `load-on-startup` from 96gb** — on-demand is better for helpers.

## File Map

| File | Contents |
|------|----------|
| [current-models.md](./current-models.md) | Analysis of models currently in the repo |
| [new-models.md](./new-models.md) | Newly discovered models worth adding |
| [mtp-speculative.md](./mtp-speculative.md) | MTP/speculative decoding support status |
| [small-models.md](./small-models.md) | Small models 4-15B for 8GB/12GB GPUs |
| [too-large.md](./too-large.md) | Models too large for reliable single-GPU |
| [strategy.md](./strategy.md) | Preset structure, personas, decision framework |
