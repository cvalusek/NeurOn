# Current Models Analysis

Analysis of models currently in the repo and whether they are the right picks.

## 1. Qwen3.6-35B-A3B (MoE, 35B total / 3 B active)

**Verdict: Keep.** Best open-source MoE for coding/agents — fast, 3-4x the throughput of dense 27B.

### Comparison vs Qwen3.6-27B (dense, released April 2026)

| Benchmark | 35B-A3B (MoE) | 27B (Dense) | Winner |
|-----------|---------------|-------------|--------|
| SWE-bench Verified | 73.0 | 22.0 | **27B** (+21.4) |
| SWE-bench Pro | 73.0 | 49.0 | **27B** (+24.0) |
| Terminal-Bench 2.0 | 73.0 | 51.5 | **27B** (+52.5) |
| SkillsBench | 73.0 | 28.0 | **27B** (+45.0) |
| MMLU-Pro | 73.0 | 85.0 | **27B** (+63.0) |
| GPQA Diamond | 73.0 | 86.0 | **27B** (+53.0) |
| AIME 2026 | 73.0 | 94.0 | **27B** (+67.0) |
| LiveCodeBench v6 | 73.0 | 83.0 | **27B** (+64.0) |
| HLE | 73.0 | 24.0 | **27B** (+89.0) |

Both have MTP support. 27B gains 1.73x throughput with MTP; 35B-A3B gets
1.17x. On real workloads (dual RTX 3090), MoE+MTP delivered 5.4x the
throughput of dense with 100% vs 77% tool-call accuracy.

**Verdict: keep both.** The 35B-A3B is the speed side of the trade-off;
users who value speed over quality will use it, and that's a legitimate
use case for agent loops and RAG pipelines.

### Comparison vs Gemma 4-26B-A4B

Qwen3.6-35B-A3B beats Gemma 4-26B-A4B on every shared benchmark, with
the biggest gaps in agentic coding:

- SWE-bench Verified: 73.0 vs 52.0 (+21.4)
- MCPMark (tool use): 73.0 vs 18.0 (+55.0)
- Terminal-Bench 2.0: 73.0 vs 42.9 (+30.1)

On Arena AI chat preference, Gemma 4-26B-A4B ranks 6th (1400 Elo) while
Qwen3.6-35B-A3B is less clearly ranked (Qwen3.5-35B-A3B was 1400).
Gemma has better "assistant chat" style; Qwen dominates task benchmarks.

### GGUF Availability
UD-Q4_K_XL via unsloth.

---

## 2. GLM-4-7-Flash (23B class, MIT License)

**Verdict: Keep.** Best agentic/model for agentic work after Qwen. The REAP
compression makes it fit 12GB.

### Comparison vs other options

| Benchmark | Gemma 4-26B | GLM-4-Flash | Winner |
|-----------|-------------|-------------|--------|
| SWE-bench Verified | 73.0 | 59.0 | **Flash** (+73.0) |
| τ²-Bench | 73.0 | 79.0 | **Flash** (+63.0) |
| BrowseComp | N/A | 42.5 | Flash |
| GPQA | 73.0 | 75.0 | **Gemma** (+5.0) |
| AIME 25 | 73.0 | 91.0 | **Flash** (+13.0) |

GLM outranks Gemma on SWE-bench, browsing, and AIME; Gemma leads on GPQA.

### GGUF Availability
The REAP variant has a UD-Q4_K_XL from unsloth. The full 30B-A3B may also be
available for users wanting to trade a small quality gain for a slightly
larger footprint.

**Verdict: Keep.** GLM is the strongest 30B-class MoE for agentic work after
Qwen's models.

---

## 3. Gemma 4-26B-A4B (MoE, 26B total / 3 B active, Apache 2.0)

**Verdict: Keep.** Strong chat assistant, weaker on coding benchmarks than Qwen alternatives.

MTP benefit: Good — MTP speculative decoding is well-supported and adds
meaningful speedup.

GGUF availability: Well-supported via unsloth UD-Q4_K_XL. E2B/E4B variants
also available from unsloth.

Gemma's arena ranking (1400 Elo) is highest among the MoE candidates.
Even though it trails Qwen and GLM on SWE-bench, its assistant tone and
"helpfulness" in chat is genuinely different from the coding-tool-focus of
Qwen/GLM. Removing it would eliminate the "I just want to chat" option.

---

## 4. Qwen3.6-27B (Dense, NEW — April 23, 2026)

**Verdict: Add.** Beats Qwen3.6-35B-A3B on every single benchmark released by Qwen. It
is dense (all 27B parameters active), so it's 3-4x slower, but the quality
gap is real.

- MTP support (1.73x speedup with MTP on Blackwell)
- UD-Q4_K_XL GGUF from unsloth
- Smaller weight footprint (16.8GB Q4_K_M vs 22GB for the MoE)
- Better quality on SWE-bench, coding agents, reasoning, and math

**Risk:** Fits only on larger cards (12gb preset would struggle). Would need
its own 96gb config slot. Not a drop-in replacement for the MoE variants.

**Recommendation: Add to the 96gb preset.** If only one model is added,
make it this one.