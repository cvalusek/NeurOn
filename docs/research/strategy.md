# Strategy & Recommendations

Preset structure, personas, and decision framework for model selection.

## Preset Personas

| Preset | Persona | Use Cases |
|--------|---------|-----------|
| 96gb | Research / Power User | Maximum capability, long context, multi-model |
| 12gb | Developer / Agentic Workflow | Agentic coding on constrained hardware |
| 8gb | Entry Level / Experimentation | 8GB cards, CPU offload, heuristic values |

## Preset Model Rosters

### 96gb — "Research / Power User"
4 preloaded + 2 on-demand. Currently loads 5 at startup → pushes headroom.
Drop `load-on-startup = true` from E2B/E4B (free up VRAM for new models).

| Model | Type | VRAM (Q4) | Load on startup? |
|-------|------|-----------|-----------------|
| qwen3.6-35b-a3b | speed MoE | 22GB | ✅ Yes |
| qwen3.6-27b | quality dense | 17GB | ✅ Yes |
| glm-4.7-flash | tool use | 24GB | ✅ Yes |
| nemotron-3-30b | math/long-context | 24GB | ✅ Yes |
| gemma-4-e2b | fast helper | 2.6G | ❌ On-demand |
| gemma-4-e4b | fast helper | 4.2GB | ❌ On-demand |

### 12gb — "Developer / Agentic Workflow"

Currently has 6+ model sections with untested `n-cpu-moe` values. Drop all
`-256k` variants (untested config values).

| Model | Type | VRAM (Q4) | n-cpu-moe |
|-------|------|-----------|-----------|
| qwen3.6-35b-a3b | speed MoE | 24GB | 18 |
| glm-4.7-flash | tool use | 24GB | 12 |
| gemma-4-26b-a4b | chat | 14GB | 12 |
| qwen3-8b | generalist | 6GB | 18 |
| gemma-4-e2b | fast helper | 2.6GB | 0 |
| gemma-4-e4b | fast helper | 4.2GB | 9 |

### 8gb — "Entry Level / Experimentation"

Mirror 12gb but with higher `n-cpu-moe` values (per AGENTS.md, these are
entirely heuristic). **Document that all values are untested estimates.**

Same 5 models as 0gb, same n-cpu-moe pattern, adjusted upward by ~30%.

## Decision Framework for Future Additions

| Question | Add? |
|----------|------|
| Does it fill a category no current model covers? | ✅ Evaluate |
| Does it improve an existing category (>5 benchmark Δ)? | ❌ Not sufficient |
| Does it fit on presets without config complexity spike? | Check VRAM |
| Does it mature GGUF + llama.cpp support? | Must have |
| Is it from a different lab (reduces single-vendor risk)? | Plus |

**Rule: One model per quarter max.**

Reasons:
- Each new model adds ~20-40GB download size and config complexity
- The LRU eviction TOCTOU race (AGENTS.md issue #20137) means
  more loaded models = more failure surface
- Users need time to learn what each model is good for

## Priority of Additions

| # | Action | Effort | Impact | Preset |
|---|--------|--------|--------|--------|
| 1 | Add Qwen3.6-27B | Low (~17GB download) | High — quality tier | 96gb |
| 2 | Add Nemotron-3-Nano-30B | Low-Medium (~24GB download) | High — math niche | 96gb |
| 3 | Drop E2B/E4B `load-on-startup` from 96gb | Trivial | Medium — frees VRAM | 96gb |
| 4 | Drop 256k variants from 12gb | Trivial | Medium — removes untested | 12gb |
| 5 | Add Qwen3-8B to 12gb | Low | Low — generalist option | 12gb |
| 6 | Document preset personas | Low — documentation | Low-Medium — helps users | All |

## Category Coverage

| Role | Model | Gap? |
|------|-------|------|
| Coding (speed) | Qwen3.6-0B-A3B | ✅ |
| Coding (quality) | Qwen3.6-27B (new) | ✅ |
| Tool use/agents | GLM-4-Flash-2-B | ✅ |
| Math/reasoning | Nemotron-3-Nano-30B (new) | ✅ |
| Chat/assistant | Gemma 4-26B-A4B | ✅ |
| Fast helper | E2B/E4B | ✅ |
| Long context (1M) | Nemotron-3-Nano (new) | ✅ |
| Small/edge | Qwen3-4B (new, 8gb) | ✅ |

**After proposed additions, ALL categories are covered.**

## When to Consider Removing a Model

1. When a newer model **consistently beats it on both quality AND speed**
   current: nothing beats 35B-A3B on speed, nothing beats GLM on tools,
   nothing beats Gemma on chat Elo.
2. When VRAM pressure forces a removal decision and the model's category
   is covered by another model (consider: Qwen3.6-35B-A3B is most likely
   candidate for removal once 27B adds MTP speedups).
3. When the model is outdated and newer models in the same family replace it.