# Small Models (4-15B) for 8GB / 12GB GPUs

Candidates for the small-card presets. All are dense (non-MoE), which simpl
VRAM management since no expert offloading is needed.

## Top candidates

| Model | Params | Q4_K_M Size | VRAM (12GB w/ 4K ctx) | MMLU | License | 8GB Viable? |
|-------|--------|------------|-----------------------|------|---------|-------------|
| Qwen3-4B | 4.0B dense | ~3GB | ~5GB ✅ | 73.0 | Apache-2.0 | ✅ Yes |
| Qwen3-8B | 8.2B dense | ~5-6GB | ~10-11GB ⚠️ | 76.9 | Apache-2.0 | ⚠️ Low ctx |
| Phi-4 | 14B dense | 9.05GB | ~12-13GB ❌ | 84.8 | MIT | ❌ No |
| Nemotron-Nano-4B | 3.97B hybrid | ~4.5GB | ~6GB ✅ | Not reported | NVIDIA | ✅ Yes |
| DeepSeek-Coder-V2-Lite | 2.4B active | ~10GB | ~12-14GB ❌ | ~41.0 | DeepSeek | ❌ Borderline |

## Qwen3-4B (highest priority for 8gb)

- MMLU 73.0, GPQA 36.9, GSM8K 87.0, MATH 54.1, EvalPlus 63.5, MBPP 67.0
- 3GB Q4_K_M — easily fits 8GB with 5GB+ for context
- 231 quantized variants available via bartowski, second-state, unsloth, Qwen official
- Beats Gemma-E2B (~300M active) and E4B (~2B active) on all benchmarks
- **Verdict: Add to 8gb.ini as a general-purpose model alongside GLM and E2B/E4B**

## Qwen3-8B (best 12GB candidate)

- MMLU 76.9, GPQA 44.4, GSM8K 89.0, MATH 60.0, EvalPlus 67.0, MBPP 69.0
- 5-6GB Q4_K_M — fits 12GB at 32K-64K context
- 305 quantized variants available
- 128K native context, extendable to 262K with YaRN
- **Verdict: Add to 12gb.ini as a generalist alongside GLM and Gemma**

## Nemotron-Nano-4B (math specialist for small cards)

- AIME25: 78.5, MATH500: 95.0, GPQA: 53.2, LiveCodeBench: 51.0
- Exceptional for a 4B model — competitive with some 7B models
- Absence of MMLU/HumanEval data is a gap
- **Verdict: Worth investigating, but Qwen3-4B is safer bet for 89gb**

## Non-starters

| Model | Reason to skip |
|-------|---------------|
| Phi-4 | 9.05GB Q4_K_M leaves ~3.5GB for cache — too tight for 12GB with any meaningful context. Also 16K context limit. |
| Phi-4-Reasoning | 53.0 GB Q4_K_M — tight fit |
| DeepSeek-Coder-V2-Lite | Coding-specialized only, doesn't generalize. Would need Q3_K_M (~7.6GB) for 12GB with short context. |
| SmolLM2-1.7B | Not competitive at MMLU-Pro 19.3 vs Qwen3-4B's 50.58. Only useful for ultra-low edge cases. |
| Mistral-Small-24B | Requires ~55GB VRAM even in bf16 — fits 4090 only with heavy quantization. Too large for 8-12GB. |