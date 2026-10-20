# Free inference pilot decision

Researched October 20, 2026. This supplements the active [server-powered pilot](PILOT.md). **The authorized provider budget is $0.** Prove useful, repeatable demand before considering rented servers. Even meeting a pilot milestone does not authorize a purchase: the owner must choose that separately. No paid plan, trial, card activation, credit purchase, automatic overage or paid fallback is permitted.

## Decision now

Keep the existing website, managed accounts and Samsung running. Test changes in disposable offline containers before changing the live engine. Preserve the selected HauhauCS Qwen3.5 2B Aggressive model, ephemeral chat, request isolation, complete-answer handling and thermal limits. Visitors will not download models or contribute compute. Google OAuth remains owner work.

No researched service establishes a free, fast, custom-model backend for 50,000 monthly active users. That is a future sizing target, not a present capability or proof that the product is bad. A small pilot can test usefulness first; both latency and capacity must still be measured honestly.

## Provider shortlist

| Option | Current evidence | Decision for this product |
| --- | --- | --- |
| Existing Samsung | No new provider charge. Selected model, privacy boundary and startup are already working; decode remains about 3.8 tokens/second. | Continue bounded local experiments. Existing electricity/internet are still real operating resources. Do not raise thermal guards to manufacture a speed win. |
| Hugging Face personal ZeroGPU | Free hosting requires verified email and account older than 30 days. Default allocation is shared 48GB GPU capacity. Free-account usage is limited to five GPU minutes/day, with queueing. | Owner reports a newer account: hosting is pending eligibility. Prepare source only; verify actual account quota and exact-model compatibility later. A shared backend token's quota is not multiplied by Offscript accounts. No production traffic or GPU test has run. [Official documentation](https://huggingface.co/docs/hub/en/spaces-zerogpu). |
| Groq Free | Model-specific organization limits; the published table currently lists 30 requests/minute, 1,000/day and token limits for several text models. Account limits can differ. | Potential optional comparison only. Its hosted catalogue does not provide our selected custom GGUF; do not silently change models or promise unrestricted behavior. No account/key or integration created. [Rate limits](https://console.groq.com/docs/rate-limits), [models](https://console.groq.com/docs/models). |
| Cloudflare Workers AI Free | 10,000 neurons/day; Free fails after its limit. Some models require paid billing and are excluded. | A bounded hosted-model comparison could fit the budget; exact selected custom weights are not provisioned. No replacement or account change. [Pricing and free limit](https://developers.cloudflare.com/workers-ai/platform/pricing/). |
| OpenRouter free variants | No-purchase allowance is 50 free-model requests/day, subject to request-rate and upstream limits. Paid routing is separate. | Too limited for a shared large service; not an exact-model solution. Do not buy credits for higher allowances or enable automatic paid routing. [Official limits](https://openrouter.ai/docs/api_reference/limits). |
| Modal | Starter includes monthly compute credits within a metered service; load time, execution and resources can consume them. Shared Endpoints are billed separately from the first token. | Excluded from activation under this instruction. Included credits do not establish a durable zero-charge production backend. No deployment, trial or billing created. [Pricing](https://modal.com/pricing). |
| Cerebras | Current docs describe a payment-method-gated, time/credit-bounded trial, with no permanently renewing free tier. | Excluded. Older articles describing an always-free tier are stale. [Current rate limits and trial FAQ](https://inference-docs.cerebras.ai/support/rate-limits). |
| Colab free notebooks | Opportunistic interactive compute; free managed runtimes restrict unrelated web-service offerings and can terminate. | Not a production SaaS backend. No proxy tunnel or restriction bypass. [Official FAQ](https://research.google.com/colaboratory/faq.html). |

No free allowance in this table is a measured concurrency guarantee, SLA or future price promise. Recheck official terms and the actual account before activation. Do not distribute traffic across extra accounts to evade limits. No customer prompts were sent to these providers during research.

## Local experiments and decisions

Experiments use the pinned production engine/template and synthetic prompts in separate rootless containers: no external network, read-only model/source/root, scratch tmpfs, 1 CPU, 2 threads, 2,500 MiB RAM, zero swap, bounded processes/files/time, and a 75°C abort guard. Live services remain unchanged. Short runs cannot establish sustained temperatures, model quality or capacity. The metadata-only [raw comparison](evidence/cpu-options-20261020.json) records samples, controls, pinned checksums and fixed synthetic prompts; no visitor content is included.

| Experiment | Observed result | Release decision |
| --- | --- | --- |
| Previously released request-local prefix reuse | One DNS comparison saved 33.64 seconds through 512 tokens; actual decode stayed about 3.8 tokens/second. | Keep. It removes repeated processing within the same request, not all waiting. See [ANSWER-PREFILL.md](ANSWER-PREFILL.md). |
| Flash Attention on | 3.820 versus baseline 3.848 decoded tokens/second in one 96-token seasons sample. | No improvement; not deployed. |
| Batch 512 / microbatch 128 | 3.813 versus baseline 3.848 tokens/second in the same short workload. | No improvement; not deployed. Kernel comparison peak 70°C. |
| N-gram speculative decoding, lookup 4 / draft 8 | General sample 3.504 versus 3.874 tokens/second; coding sample 2.863 versus 3.863. Matching output fingerprints for each pair; 96-token caps did not finish naturally. | Slower on both measured workloads; not deployed. Comparison peak 73°C. Not a quality assessment. |
| One thread / CPU-affinity / higher CPU quota | Earlier short wins failed the longer 75°C validation guard. | Do not deploy short-run wins or repeat them as new discoveries. |
| Same checkpoint, Q8_0 instead of Q4_K_M | Q8_0 general 3.534 versus Q4_K_M 3.844 tokens/second; coding 3.520 versus 3.839. Peak 73°C. Both variants are pinned to the same publisher revision; one short sample per workload, not a full-answer/quality assessment. | Slower on both measured workloads; not deployed. Preserve the current artifact. |
| MNN alternative engine | SSE4.1 backend and model-family support make investigation plausible. The earlier import/matmul test did not load this LLM. The official lower-memory GGUF importer also accepts an existing MNN graph; Transformers separately documents Qwen3.5 GGUF loading/dequantization. | Exact selected tensor coverage, matching graph/tokenizer/template, memory budget and adapter lifecycle remain unvalidated. Do not mix in stock-model weights. No inference speed claim. [MNN GGUF workflow](https://github.com/alibaba/MNN/blob/master/docs/transformers/llm.md#gguf-转-mnn), [importer source](https://github.com/alibaba/MNN/blob/master/transformers/llm/export/gguf2mnn.py), [GGUF loading](https://huggingface.co/docs/transformers/quantization/gguf). |
| vLLM on this CPU | Samsung has AVX/F16C but no AVX2/AVX-512, which current x86 vLLM CPU requirements need. | Not a supported drop-in on this hardware. vLLM is not itself free GPU supply. [Requirements](https://docs.vllm.ai/en/latest/getting_started/installation/cpu/). |

The supplied Reddit case used an NVIDIA GPU; its offload recommendations do not map to the Samsung. The two supplied latency articles are useful leads, not benchmark evidence. Streaming, bounded input, exact template accounting and native Linux are already present. Shared caches of private answers, dropping requested content, smaller-output tricks and multiple parallel CPU generations would conflict with this product or need separate evidence. [Supplied latency overview](https://inference.net/content/llm-latency/), [supplied tutorial](https://medium.com/@vasanthank29/llm-latency-optimization-techniques-a-practical-guide-for-beginners-968c2017e0b2).

## Proof before expansion

1. Establish a useful general-assistant and coding baseline from fixed synthetic tasks, including natural completion, correctness and visible first-answer delay. Compare the same prompts, sampling, output lengths and hardware conditions; retain metrics rather than visitor chat. Separate Fast from Deep Think.
2. Release only measured improvements that also pass Stop/Retry, context/token accounting, cross-request disposal, CI and sustained thermal checks. No output cap is described as a complete answer.
3. Finish restricted database runtime, account deletion/recovery/retention, reviewed policy and eligibility flows. Keep enforcement off until its activation gates pass. Google signup and later sender-domain email work do not block this source preparation.
4. Run the planned 10 → 30 → 100 user pilot as capacity permits, with explicit allowances. Collect voluntary usefulness/return feedback and aggregate completion/latency/rejection metrics, without saving conversations. Stop expanding if waits, failures, temperatures or free limits fail the agreed pilot targets.
5. Use observed sessions, tokens, peak requests and retention to size the 50,000-MAU scenario. Present the evidence and choices to the owner. Renting infrastructure or subscribing to a provider still requires a later decision.

This is a validation sequence, not a claim that free infrastructure can already provide a fast 50,000-user service.
