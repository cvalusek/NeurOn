# Newly Discovered Models

Models discovered during research that could be added to the router.

## 1. Nemotron-3-Nano-30B-A3B (NVIDIA, December 2025)

**Verdict: Strong contender for the 30B slot — best on math/long-context, but weaker on agentic coding.**

NVIDIA's newest open model uses a hybrid Mamba-2 + Transformer MoE
architecture with only 6 self-attention layers out of 52 total.
Unique among peer models. 1M context window. UD-Q4_K_XL GGUF from unsloth (~240).

### Benchmarks vs peer 30B models

| Benchmark | Nemotron 3 30B | Qwen3-30B-A3B | GPT-OSS-200 | GLM-4-Flash |
|-----------|---------------|---------------|-------------|-------------|
| MMLU-Pro | 78.3 | 8.9 | 75.0 | ? |
| AIME25 (no tools) | 89.0 | 85.0 | 91.0 | 91.0 |
| AIME25 (with tools) | 99.0 | — | 98.0 | — |
| GPQA (no tools) | 73.0 | 73.0 | 71.0 | 75.0 |
| LiveCodeBench v6 | 68.3 | 60.0 | 61.0 | 64.0 |
| SWE-Bench (OpenHands) | 38.8 | 22.0 | 34.0 | ? |
| τ²-Bench | 49.0 | 47.7 | 47.7 | ? |
| MiniF2F pass@1 | 50.0 | 5.7 | 12.1 | ? |
| RULER@1M | 85.0 | 77.5 | — | ? |
| IFBench (prompt) | 71.5 | 51.0 | 65.0 | ? |
| AA-LCR | 35.9 | 59.0 | 34.0 | ? |
| HLE (with tools) | 93.0 | 46.6 | — | ? |

### Strengths
- **Math reasoning**: 99.2% on AIME25 with tools (highest of all 30B class)
- **Long context**: Only model with 1M context; RULER 86.3@1M beats Qwen's 77.0
- **Agentic training**: SWE-Bench 38.8 is second only to GLM-4-Flash (59.0)
- **Multilingual**: WMT24++ 8.62 (competent; Qwen3 is better at 8.06)
- **Throughput**: 3.3x faster than Qwen3-30B-A3B on single H200 (per NVIDIA)
- **MiniF2F pass@1**: 50.0% vs Qwen3's 5.7% (massive gap on formal math)

### Weaknesses
- **Multilingual**: MMLU-ProX (avg over langs) 59.5 vs Qwen3's 77.6 — significant gap
- **Long-context reasoning**: AA-LCR 35.9 vs Qwen3's 59.0 — poor at reasoning over long contexts
- **Agentic tool use**: τ²-Bench 49.0 vs GLM's 79.5 — far behind the best
- **General knowledge**: MMLU-Pro 78.3 vs GLM's 7.0 and Qwen3.6-27B's 8.0 — middling

### Hardware fit
- Q4_K_XL: ~24GB — fits on 12GB with CPU-offload, works on 8GB with heavy offload
- Q8_K_XL: ~38GB — fits on 96GB
- llama.cpp support: Yes (via bartowski and unsloth

### Where it fits in the router
Nemotron fills a unique niche: **pure math/formal reasoning** (MiniF2F pass@1
50.0% — unmatched in the class) and **ultra-long context** (1M token window).
It doesn't beat GLM or Qwen on agentic coding, but it has distinct strengths
the others don't.

**Verdict: Add to 96gb preset as a math-long-context specialist.**

---

## 2. Cascade 2 30B-A3B (NVIDIA, March 2026)

Post-trained variant of Nemotron-3-Nano with RL on SWE-Gym / R2E-Gym. Unique:
IMO 2025 gold medal, IOI 2025 gold medal.

| Benchmark | Cascade 2 30B | Qwen3.5-35B-A3B | Nemotron-3 Super-120B |
|-----------|--------------|-----------------|------------------------|
| IMO 2025 | 🥇 Gold | — | — |
| IOI 2025 | 🥇 Gold | — | — |
| AIME 2025 | 92.4 | 91.0 | — |
| HMMT Feb25 | 94.6 | 89.0 | — |
| LiveCodeBench v6 | 87.2 | 74.0 | — |
| ArenaHard v2 | 83.5 | 65.4 | — |
| IFBench | 82.9 | 70.2 | — |

**VRAM**: Q4_K_M at 24.7GB — barely fits a 24GB card. IQ4_XS at **18.3GB** —
fits 24GB with headroom, runs at ~187 tok/s per community reports.

**MTP status**: No MTP heads on Cascade 2 (NVIDIA designed it as pure
post-training, not MTP).

**GGUF**: `bartowski/nvidia_Nemotron-Cascade-2-30B-A3B-GGUF` — Q4_K_M (24.7G),
Q4_K_S (22.5G), Q4_K_L (24.9G), Q4_1 (20.1G), IQ4_XS (18.3G).

**Where it fits**: Beats Qwen3.5-35B-A3B on coding (LiveCodeBench 87.2 vs
74.0) and arena-hard reasoning. The math/olympiad gold stands alone. But it's
too large for 12GB at Q4 (24.7GB) — would need IQ4_XS at 18.0GB. More of a
48-96GB model with a 12GB stretch via extreme quant.

**Verdict: Strong "maybe" for 96gb.** If there's a math or
competitive-coding use case, it's worth the download. But the Q4 size is tight
even on 48GB, so IQ4_XS (18.3GB) is the only practical quant. NVIDIA doesn't
publish MMLU-Pro or GPQA for it, so quality is harder to judge outside
coding/math.

---

## 3. Qwen3-Coder-30B-A3B-Instruct (May 2025)

- 35.5B total / 3.3B active MoE
- SWE-bench Verified: ~64% (per community reports)
- Aider Polyglot: ~45%
- **GGUF**: UD-Q4_K_XL at **17.7GB** from
  `unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF`, also from bartowski
- **MTP**: Likely has MTP (same Qwen3-Coder family as Qwen3.6 which has it),
  embedded in GGUF
- **VRAM fit**: 17.7GB Q4 — fits 24GB comfortably with context

**Comparison vs lineup**: SWE-bench ~64% is between GLM-4-Flash (59.0) and
Qwen3.6-35B-A3B (73.0). If MTP is confirmed, it's a very tight fit for the
router. **Worth verifying the GGUF has MTP heads.**

### Qwen3-Coder-Next 80B (Feb 2026)
- SWE-bench Verified: ~71.0% — matches Claude Sonnet 4.5
- Q4_K_M: ~48.7GB — needs dual GPU or 0GB unified
- IQ2_XXS: ~19.3GB but quality degrades heavily
- **Verdict: Too large for single-GPU practical use.** Keep on watchlist for
  48GB+ setups.