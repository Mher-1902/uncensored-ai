---
title: Offscript Cloud Model
emoji: 🕶️
colorFrom: gray
colorTo: green
sdk: gradio
sdk_version: 6.28.0
python_version: 3.12
app_file: app.py
pinned: false
license: apache-2.0
---

Offscript's proposed, stateless GPU backend. **Not yet deployed or GPU-validated.**

Only the **free personal ZeroGPU** path is in scope. Current eligibility requires a verified email and an account older than 30 days; the owner's newer account does not yet meet that gate. Do not create this candidate on paid hardware, add billing, subscribe, buy credits or use multiple accounts to evade eligibility/quotas. No hardware suggestion is included. See the dated [free pilot decision](../../docs/FREE-INFERENCE-PILOT.md) and [official ZeroGPU documentation](https://huggingface.co/docs/hub/en/spaces-zerogpu).

This uses a pinned 4-bit compressed-tensors quantization of Huihui Qwen3.5 9B. The publisher calls it AWQ; its on-disk format is compressed-tensors. It uses Transformers inside ZeroGPU's supported Gradio lifecycle, not a persistent vLLM server.

The `/generate` API accepts a JSON array of `{role, content}` messages and an integer token budget. It rejects more than 63 messages, more than 65,536 total characters, extra message fields, blank content and invalid budgets before requesting GPU allocation. It preserves code whitespace and rejects oversize history instead of trimming it. It streams the current answer. No chat state, database, flagging, example cache, or application prompt logging is configured. Hugging Face still controls infrastructure and queue retention.

Before connecting the website: inspect build/runtime logs without retaining prompts, confirm GPU memory fits, test multi-turn responses and cancellation, benchmark warm and cold requests, and test the expected concurrent load. The current candidate still lacks the production adapter's token/template, natural-completion/continuation and confirmed-worker-disposal contract; a bounded thread join is not cleanup proof. It must not receive production traffic until those gates pass. The 9B candidate is not the selected Samsung 2B model and must not silently replace it. Free quota is not an availability guarantee. This template is not a claim that those GPU checks have passed.
