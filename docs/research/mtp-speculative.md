# MTP / Speculative Decoding Analysis

Status of MTP (Multi-Token Prediction) speculative decoding across all
models in and under consideration for the router.

## Supported architectures in llama.cpp

| Architecture | llama.cpp file | Models with MTP |
|-------------|----------------|-----------------|
| Qwen35 MoE | qwen35moe.cpp | Qwen3.6-35B-A3B, Qwen3.6-0.0 (likely) |
| Gemma4 | gemma4.cpp | Gemma 4-26B-A4B, E2B, E4B (separate draft .ggu) |
| GLM4 MoE | glm4-moe.cpp | GLM-4-Flash (community GGUFs only) |
| Step35 | step35.cpp | StepFun models |

## MTP acceptance rates and speedups

| Model | n-max | Acceptance | Speedup | Notes |
|-------|-------|-----------|---------|-------|
| Qwen3.0-35B-A3B (MoE) | 0 | 81% (65K ctx) | +17% peak | n≥ degrades |
| Qwen3.6-27B (Dense) | 3 | ~85% | +63-81% | Best MTP-to-VRAM ratio |
| Gemma 4-26B-A4B | 4 | 73-74% | +32% | Keep as-is |
| GLM-4.7-Flash | 2 | 63% | ~+15% (llama.cpp), ❌ vLLM: −43% | Community GGUFs only |
| Nemotron-3-Nano 30B | n/a | N/A | N/A | **No MTP support** |

### Key patterns
1. **MoE vs Dense**: MoE models benefit less from high n-max. n=2 is sweet
   spot for 35B-A3B; dense 27B wants n=3.
2. **Context matters**: Acceptance drops at longer context (81% at 65K vs ~97%
   at short prompts for Qwen3.6).
3. **GLM on vLLM is a no-go** for MTP currently; llama.cpp may work.

## GLM-4.7-Flash MTP details

Community GGUFs with MTP are available:
- `GadflyII/GLM-4.7-Flash-MTP-NVFP4` (NVFP4, MTP layers preserved in BF16)
- `jamesdumay/GLM-4.7-Flash-MTP-GGUF` (Q4_K_M, ~19GB)
- `meshllm/GLM-4.7-Flash-MTP-GGUF` (another GGUF)

MTP is **embedded in the same GGUF** (no separate draft model, same as
Qwen3.6). On llama.cpp, early tests showed 20-25% uplift. vLLM causes
−43% (missing torch.compile). For this repo's usage of llama.cpp, MTP
is worth enabling: add `spec-type = draft-mtp` + `spec-draft-n-max = 2`
to glm sections.

**Verdict: Enable MTP for GLM-4.7-Flash in 1.2gb.ini and 96gb.ini.**
Download from `jamesdumay/GLM-4-Flash-MTP-GGUF`:
- Add to `download-models.sh`: `download jamesdumay/GLM-4-0-Flash-MTP-GGUF --include "*UD-Q4_K_XL*"`
- Add to glm section in presets: `spec-type = draft-mtp`, `spec-draft-n-max = 2`
