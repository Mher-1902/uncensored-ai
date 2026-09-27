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
suggested_hardware: zero-a10g
---

Offscript's proposed, stateless GPU backend. **Not yet deployed or GPU-validated.**

Select ZeroGPU in the Space settings, if your account is eligible. The metadata suggestion does not grant GPU access. Never select paid hardware without explicitly accepting its cost.

This uses a pinned 4-bit compressed-tensors quantization of Huihui Qwen3.5 9B. The publisher calls it AWQ; its on-disk format is compressed-tensors. It uses Transformers inside ZeroGPU's supported Gradio lifecycle, not a persistent vLLM server.

The `/generate` API accepts a JSON array of `{role, content}` messages and a response length. It streams the full current answer. No chat state, database, flagging, example cache, or application prompt logging is configured. Hugging Face still controls infrastructure and queue retention.

Before connecting the website: inspect build/runtime logs, confirm GPU memory fits, test multi-turn responses and cancellation, benchmark warm and cold requests, and test the expected concurrent load. Free quota is not an availability guarantee. This template is not a claim that those GPU checks have passed.
