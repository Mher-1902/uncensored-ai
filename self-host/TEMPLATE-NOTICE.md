# Qwen chat templates

The active profile uses `qwen35.jinja`, an unmodified extraction of `chat_template` from the official [Qwen/Qwen3.5-2B tokenizer configuration](https://huggingface.co/Qwen/Qwen3.5-2B/blob/15852e8c16360a2fea060d615a32b45270f8a8fc/tokenizer_config.json), revision `15852e8c16360a2fea060d615a32b45270f8a8fc`. SHA-256: `273d8e0e683b885071fb17e08d71e5f2a5ddfb5309756181681de4f5a1822d80`. This Apache 2.0 source uses the included `QWEN-TEMPLATE-LICENSE`. The launcher verifies the digest in `model.json` before starting. Direct and Reasoned retain explicit `enable_thinking` behavior; both were checked against the actual Samsung binary.

## Previous profile

The following provenance is retained for the earlier template; it is no longer selected in `model.json`.

`qwen3.jinja` is an unmodified extraction of `chat_template` from the official [Qwen/Qwen3-1.7B tokenizer configuration](https://huggingface.co/Qwen/Qwen3-1.7B/blob/70d244cc86ccca08cf5af4e1e306ecf908b1ad5e/tokenizer_config.json), revision `70d244cc86ccca08cf5af4e1e306ecf908b1ad5e`. The publisher licenses this source under Apache 2.0; the license is included in `QWEN-TEMPLATE-LICENSE`.

The selected GGUF embeds a simplified ChatML template without `enable_thinking`. Using the official Qwen template restores the explicit Direct/Reasoned switch and native reasoning parsing without modifying the quantized weights. Its SHA-256 is pinned in `model.json` and verified at startup.
