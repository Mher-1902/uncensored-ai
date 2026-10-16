# Samsung model profile — October 16, 2026

The owner selected [HauhauCS/Qwen3.5-2B-Uncensored-HauhauCS-Aggressive](https://huggingface.co/HauhauCS/Qwen3.5-2B-Uncensored-HauhauCS-Aggressive). Use the publisher's Q4_K_M GGUF, not its whole repository or an unrelated model bearing a similar name. Reduced-refusal claims do not establish answer quality or guarantee that every request succeeds.

`self-host/model.json` pins the 1,270,808,032-byte file, repository revision `2bcf35c1ebf62c837c12c1aa90b578ff4717e831`, SHA-256 `be3ccca13a9d1bc8b67165ea80bd103cd6151a37ad131183cc7ca388f78d9517`, and the official Qwen3.5 template. The downloaded weights passed the full checksum. The existing llama.cpp revision `0504396140d1c882f5f6ee34466a42db7ae90114` already implements Qwen3.5 and passed real inference; changing the engine version is unnecessary for this migration.

The Samsung is an i7-3517U with about 7.4 GiB physical RAM, AVX/F16C, no AVX2, and no usable inference GPU. [vLLM's x86 CPU installation requirements](https://docs.vllm.ai/en/latest/getting_started/installation/cpu/) require AVX2 or AVX-512. This profile therefore uses CPU llama.cpp in rootless Docker. A future vLLM deployment needs a supported host and a separate adapter for the gateway's template/tokenizer/cache-cleanup contract. Installing vLLM alone cannot accelerate unsupported hardware. Image generation remains on separate GPU infrastructure.

Keep the existing single slot, two threads, 4,096-token context, 0.8 CPU quota, 2,500 MiB container memory limit, zero application swap, loopback-only model listener, explicit Direct/Reasoned controls and cache erasure. No model weights belong in Git. Keep credentials outside the repository. No paid resource is required by this change.

## Actual candidate checks

The isolated candidate used the existing serving image with read-only mounts for the new profile/template and the same resource limits. The original model was stopped first and restored after the test. The candidate had no network access beyond loopback.

| Synthetic Direct request | First visible text | Completion | Output tokens |
| --- | ---: | ---: | ---: |
| `17 × 23`, number only | 5.097 s | 6.077 s | 4 |
| Two-sentence seasons explanation | 4.994 s | 25.111 s | 63 |

The arithmetic was correct and the explanation mentioned Earth's tilt. Both streams completed without hidden thinking. The official Direct/Reasoned templates differed correctly, token counting worked, and cancellation followed by slot erasure returned the slot to idle. Startup took 11.9 seconds; sampled temperature peaked at 66°C.

One baseline request on the old 1.7B model returned the same arithmetic result in 9.498 seconds with first visible text at 4.539 seconds, but generated 20 tokens. Different output lengths and such a small sample do not establish a general speedup. These are smoke checks, not a quality benchmark, concurrency result or sustained thermal certification. Actual Reasoned generation needs separate measurement.

Before removing the previous 1.7B weights, verify the protected gateway and a signed-in website reply on the replacement, and persist the tested profile in the Docker startup configuration. Resolve the real model path before deleting; shared/symlinked paths are not separate copies. Preserve SSH keys, private service credentials, application files and runtime binaries.
