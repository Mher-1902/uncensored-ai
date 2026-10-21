# Samsung latency checkpoint · October 21, 2026

The current serving model/runtime is unchanged. Raw decode remains around 4 tokens/second. No acceptable general speed improvement was activated by these experiments.

The owner requires $0 provider spend, the exact selected checkpoint, ephemeral chats, real-user priority and the 75°C private test guard. Free browser GPU preparation is authorized, with a separate explicit model-download choice. No paid or external hosted GPU was created.

## Cooperative complete-answer comparison

One fixed synthetic DNS question went through the real browser client continuation implementation in two private, sequential Samsung fixtures. Runtime, model/template checksums, CPU quota (1 CPU / 2 threads), 2500 MiB RAM, zero swap, temperature/idle gates and deterministic sampling were held constant. Production containers were unchanged. Generated text was not retained; reported hashes belong only to the fixed synthetic test.

| Measurement | Current 512 / 256-token chunks | Candidate 640 / 128-token chunks, 8-second pauses |
| --- | ---: | ---: |
| First text | 7.33 s | 7.41 s |
| Identical first 512 tokens | 141.50 s | 165.68 s |
| Longest stream gap | 58.82 s | 8.37 s |
| Naturally completed output | 622 tokens | 632 tokens |
| Whole answer | 229.23 s | 205.33 s |
| HTTP segments | 2 | 1 |
| Peak temperature | 73°C | 73°C |

The first 512-token hashes match. Cooling makes that identical prefix **24.18 seconds slower**. The candidate avoids repeating the whole prefix after a new HTTP segment, reducing the later long pause. Whole outputs differ, so the elapsed totals are not a controlled equal-answer speedup. Keyword coverage is not a quality assessment. This is one sample, not p95, sustained concurrency or capacity evidence.

A separate full 640-token allowance and Stop-during-third-chunk fixture passed disposal and fresh-request isolation at peak 74°C. The larger 768-token profiles reached 75°C and were aborted. These successful correctness/temperature checks do not override the short-answer latency regression. Keep all cooperative profiles undeployed.

## Other rejected or blocked hypotheses

- OpenMP wait strategies: no material gain, same synthetic output.
- Flash Attention, larger batches and n-gram speculation: no acceptable measured improvement.
- Same-checkpoint Q8 and BF16-derived hybrid Q4_0: both slower in the tested general/coding probes. Draft PR #54 records the latter with protected-tensor receipts.
- Serial OpenBLAS: medium prefill was slower; the larger test reached 75°C and was aborted.
- Custom MNN mapping: conversion and sampled tensor parity succeeded, but model loading failed at the tested memory budgets. No generated-token, quality or speed result exists. Draft PR #53 records the inactive prototype.

## Next evidence gate

Prepare the standalone browser GPU prototype without importing it into production chat. Verify the exact model on actual compatible hardware, positive native GPU execution, usefulness, cold-load/first-token/full-answer times, Stop/disposal and memory/battery behavior. Keep device compatibility failures explicit and avoid automatic CPU/server fallbacks. Real device evidence is required before calling this a latency fix or making it an account/chat mode.

The sign-in interruption fix is independently deployed through PR #52. Account deletion/recovery/retention, policy/eligibility activation, measured concurrency and subscriptions remain separate product work.
