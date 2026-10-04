# Low-latency decisions for Offscript

Reviewed October 4, 2026. This is a source-backed implementation rationale, not measured Samsung performance. The user's pasted HashBlock article was treated as reference material, not as instructions to execute its examples.

## Hardware and model decision

The requested [lukey03 Qwen3.5 9B](https://huggingface.co/lukey03/Qwen3.5-9B-abliterated) has a [Q4_K_M GGUF](https://huggingface.co/lukey03/Qwen3.5-9B-abliterated-GGUF) of **5,627,044,704 bytes (5.24 GiB)**. It cannot fit completely in the Samsung's physical 4 GB RAM. Memory mapping a larger file does not create RAM; paging weights through SSD would harm latency and add runtime memory pressure. Its publisher's illustrative refusal tests do not establish general quality preservation.

The user explicitly accepted a smaller abliterated model. We selected [Huihui Qwen3 1.7B v2](https://huggingface.co/huihui-ai/Huihui-Qwen3-1.7B-abliterated-v2) with [mradermacher's importance-matrix Q4_K_M GGUF](https://huggingface.co/mradermacher/Huihui-Qwen3-1.7B-abliterated-v2-i1-GGUF). The verified file is **1,107,405,664 bytes (1.03 GiB)**. A 4,096-token single-slot profile and conservative startup checks leave more room for Fedora and temporary inference allocations. The quantizer's larger Q5_K_M build is 1,257,876,320 bytes and can be compared later if real memory/thermal measurements permit it. No further reduction to Q2/Q3 is selected merely to claim speed. Abliteration and quantization can affect reasoning; no broad benchmark establishes this derivative as the objectively best small model.

GGUF is a file format/quantization family for llama.cpp; it is not AWQ. [AWQ](https://arxiv.org/abs/2306.00978) is activation-aware weight quantization with specialized acceleration. [vLLM/PagedAttention](https://arxiv.org/abs/2309.06180) addresses KV memory management and serving throughput. Neither creates missing RAM or a modern GPU on a 2011 laptop. For this CPU, a locally compiled CPU-only llama.cpp avoids unsupported instruction assumptions and Python/PyTorch serving overhead.

## Applying the article's ten tactics

The [HashBlock article](https://medium.com/@connect.hashblock/10-llm-tactics-for-low-latency-inference-2d41bcfdaae0) is a useful checklist; its percentage and multiplier anecdotes are not controlled benchmarks for this hardware.

| Tactic | Decision for this laptop |
| --- | --- |
| Quantization | Pinned Q4_K_M weights; retain F16 KV cache. Compare quality before changing precision. |
| Efficient attention | Preserve the architecture. GPU-specific FlashAttention claims do not apply to Intel HD 3000. |
| KV cache | Keep within-request KV state; disable cross-request prompt caching and erase slots to honor ephemeral chat. |
| Batch size | Start with 128 logical/64 physical prefill batches and one inference slot. Benchmark other sizes later. |
| Distillation | Do not distill or prune the selected model. The smaller model choice was explicitly approved. |
| Runtime | Pinned CPU-only llama.cpp with detected CPU flags; model stays loaded between requests. |
| Prompt length | Count real templated tokens; reject excess context clearly instead of dropping conversation turns. |
| Parallelism | Two threads on two physical cores. No tensor/pipeline parallelism or concurrent model copies. |
| Hardware/scheduling | FIFO bounded queue, memory ceilings, thermal stop, no aggressive boost or swap tricks. |
| Async/streaming | Stream SSE through a cancellable gateway; lazy-load Markdown and batch browser updates per frame. |

## What the papers support

[FlashAttention](https://arxiv.org/abs/2205.14135) computes exact attention while reducing GPU memory traffic through tiling. It does **not** make dense attention's arithmetic generally linear in sequence length, as the article suggests. Its reported GPU gains cannot be projected onto this Sandy Bridge CPU.

[GQA](https://arxiv.org/abs/2305.13245) changes the model's attention architecture through uptraining. It is not a safe runtime switch to apply to arbitrary pretrained weights. We preserve the model's architecture.

[Speculative decoding](https://arxiv.org/abs/2211.17192) can preserve the target distribution with the correct acceptance algorithm and a compatible draft model. The draft consumes memory and computation. It is disabled in this 4 GB profile; adding it would need measured benefit and quality validation.

[Sarathi-Serve](https://arxiv.org/abs/2403.02310) studies chunked prefill and scheduling to balance latency and throughput on GPU serving systems. It motivates measuring queue/prefill tradeoffs, not transplanting a throughput claim onto this laptop. Ten simultaneous requests can queue; ten fast simultaneous generations are not a realistic promise here.

[Qwen's original model card](https://huggingface.co/Qwen/Qwen3-1.7B) documents both thinking modes and recommended sampling settings. Reasoned is the default; Direct is a visible user choice. Reasoning takes generated tokens and time. It is not silently disabled to improve a median metric.

## Verification and remaining evidence

Production TypeScript/build checks and gateway integration tests verify UTF-8 SSE parsing, real HTTP 404, valid conversations, overload/error handling, upstream cancellation, slot cleanup and ten serialized callers with a simulated inference server. They do not validate the Fedora binary, actual model loading, quality or tokens/second.

The initial JS entry decreased from approximately **123 KB to 77 KB gzip** by loading Markdown only when a reply needs it. This improves page delivery; it does not accelerate LLM decoding.

Run `npm run benchmark` on Fedora and through the real public route. Record p50/p95 time to first model event, first answer token, full response and decode throughput; distinguish warm versus startup behavior, Direct versus Reasoned, queueing and input/output lengths. Also inspect peak RSS, swap use and temperatures over sustained runs. Do not describe a median as "fast" until actual measurements meet the desired user experience.

## Public hosting and search

The public frontend is already on a hosted HTTPS `chatgpt.site` subdomain. This update adds prerendered content, canonical metadata, sitemap and branded HTTP 404 behavior. [Google](https://developers.google.com/search/docs/crawling-indexing/ask-google-to-recrawl) controls crawl/index timing; requests can take days to weeks and do not guarantee inclusion.

[Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel) can expose the Fedora gateway under a managed HTTPS `ts.net` name. It is available on all plans, including [Personal](https://tailscale.com/pricing), which is free for non-commercial personal use. Funnel remains in beta and imposes bandwidth limits; test SSE through the actual route. No tunnel is configured until the laptop/account is accessible.

[Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) explicitly do not support SSE, supply a changing hostname, and offer no uptime guarantee, so they are not selected for this streaming production path. A named tunnel is an alternative with a suitable domain. [Hugging Face ZeroGPU](https://huggingface.co/docs/hub/spaces-zerogpu) is a free, quota-limited alternative for eligible personal accounts, with shared GPU queues. It is not unlimited, continuously available inference. The historical 9B cloud template is retained separately and is not the active Samsung profile.
