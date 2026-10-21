# Private MNN CPU conversion prototype

This experiment converts the selected HauhauCS Qwen3.5 2B checkpoint into an MNN graph without using stock learned weights. It is not connected to the application. No inference speed, answer-quality, request-isolation or capacity improvement is claimed.

The generic upstream importer assumes uniform layers and misses this model's hybrid layout. The custom mapper accounts for all 320 source tensors: 186 block matrices, 79 norms, 54 learned recurrent constants and the tied embedding/output tensor. Q4_K remains 4 bit; Q5_K and Q6_K expand to exact-value 8 bit storage with their original scales. The converter streams rows instead of materializing a dense 2B model. Norm gains and negative-A values are already transformed in GGUF and are copied directly. The2B model's equal recurrent K/V head counts make the V-head permutation an identity.

The pinned graph's20 structural constants are explicitly whitelisted. JSON graph export rounds rotary frequencies, so they are reconstructed in FP32 from the selected GGUF's rope metadata. Every learned Conv, norm and recurrent constant is replaced. No stock `.weight` file is read or committed.

## Evidence and limits

Samsung-only reference checks mapped 320 tensors and compared 561 sampled rows across 187 matrices, including all three quantization families. Maximum observed absolute error was 0.0. Bounded two-pass external-file layout checks passed for each quantization. This is sampled row-format evidence, not a full-model logits or quality comparison.

A complete private artifact was serialized on the Samsung: 1,859,371,494 weight bytes and a 3,003,000-byte graph; peak 63°C. Its hashes are in `evidence/conversion-20261020.json`. The artifact, original graph, tokenizer vocabulary and vendor binaries are deliberately excluded from Git.

Private2500MiB and 3 GiB load attempts were killed by their memory limits, including after clearing the private hash-read cache. Peak temperatures were64–70°C and serving containers were unchanged. One 3.5 GiB attempt stopped when live public work resumed. A subsequent cool/idle 3.5 GiB load also reached its private memory limit (peak 65°C). No forward call succeeded, so there is no speed result. No production memory setting was changed. Input-tokenizer parity, actual model loading, logits, speed, sustained temperatures, cancellation and cache erasure remain open gates.

The numerical core was executed in the private Samsung fixture. The added entry guard separately passed in a 128 MiB/0.1 CPU offline Samsung container; all three entry files rejected execution without the private fixture marker before importing numeric dependencies. Syntax checks passed for every Python helper. Never call this a deployable runtime based on conversion success.

## Execution boundary

`fixture_guard.py` requires Linux, explicit `OFFSCRIPT_TEST_FIXTURE=private-mnn-model-test`, a read-only container root, loopback-only networking, at most 0.25 CPU/1 GiB and zero swap. It is a start-time guard; it does not replace an external supervisor. The operator must also monitor the 75°C limit, AC power, free-memory reserve, live-work priority and a fixed wall deadline, removing only the owned experiment container in `finally`.

Provide read-only inputs at `/models/model.gguf`, `/graph/llm.mnn` and `/input/`; vendor Python packages at `/vendor`; write only to a new private `/output` and RAM-backed `/tmp`. Generate `graph-ops.json` from the checksum-pinned structural graph on the Samsung. Never mount credentials, a Docker socket or user chat data inside the numeric container. Reference validation additionally mounts the pinned llama.cpp `gguf-py` package at `/reference`.

- `validate_codec.py`: compare sampled rows and bounded file layouts against the independent pinned GGUF decoder.
- `convert_selected.py`: verify the selected source and graph, replace every learned tensor, reconstruct rotary constants and atomically finalize a scratch artifact.
- `export_tokenizer.py`: preserve every GGUF vocabulary ID in a legacy tokenizer for private token-ID-forward tests. Encoding parity is explicitly unproven; it must not be substituted silently in production.

No application import, public route, dependency, provider, serving flag or automatic model download references this directory. Keep production on the verified existing engine until a faster candidate passes the full release gates. A free software engine does not supply a free production GPU.

## Primary sources

- Selected model identity: `self-host/model.json` in the repository root.
- [MNN source pinned at 23d05cc](https://github.com/alibaba/MNN/tree/23d05cc24f5258ff3e6fb794246acc183903274d), especially `gguf2mnn.py`, `mnn_utils.py`, `diskembedding.cpp`, `CPULinearAttention.cpp` and the exporter attention implementation.
- [Pinned GGUF conversion/reference implementation](https://github.com/ggml-org/llama.cpp/tree/0504396140d1c882f5f6ee34466a42db7ae90114), especially `conversion/qwen.py` and `gguf-py/gguf/quants.py`.
- [Pinned structural graph](https://huggingface.co/taobao-mnn/Qwen3.5-2B-MNN/tree/35781816d7b6a9dcb273a6765ac9563401951c3c).

The helper algorithms are independently implemented against those formats; third-party code and model binaries are not vendored here. See `artifacts.lock.json` for identities.
