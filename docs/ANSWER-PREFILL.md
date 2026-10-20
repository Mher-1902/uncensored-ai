# Request-scoped answer prefill reuse

October 20 measured pilot increment. PR #47 merged as `efb0d46`; native protocol 5 deployed from `1b9096d`, image `sha256:467077f0836f7118b7b85ab8cfa6432065fec4c186710d91e38e5dc349ccd311`. The optional public budget was enabled on Production `4g4bRbAijvfR2oYd6fuK6LtMd6Am`. This is not a measured capacity or model-quality claim.

Before this increment the browser asked for 256 output tokens at a time. Each subsequent HTTP request includes the generated answer prefix and the native gateway erases its slot before and after every request. Re-evaluating that growing prefix can create long pauses. An earlier isolated 64+64-token comparison measured 47.40 seconds when erasing between parts versus 37.45 seconds with reuse; the second-part first-text wait was 10.42 versus 0.24 seconds. Decode remained approximately 3.82 tokens/second, quality was not assessed, and peak temperature was 74°C. This is one synthetic pair per profile, not sustained or percentile evidence.

## Invariants

- Keep cache reuse entirely inside one open, exclusively acquired gateway request. Other requests wait under the existing bounded queue. No idle cache, cross-user reuse, durable prompt cache, content fingerprint or new receipt is introduced.
- Fast requests larger than 256 tokens use model chunks of at most 256. Continue only a complete length-stopped chunk with valid bounded usage and visible progress. Require the next rendered template to equal the previous template plus the exact streamed content, including code whitespace.
- Cap Fast output at the native deployment ceiling (512 by default, optionally768) for prompts of at most128 tokens, otherwise preserve the256-token allowance. A long prompt must not combine expensive prefill with a larger output budget near the proxy deadline.
- Hide internal length stops from the browser. Report one final stop/length result and aggregate newly generated tokens, charging the original prompt once. A transport error, mismatched template, invalid usage or cancellation never becomes successful DONE.
- The gateway retains its existing responsibility to erase the slot before admitting content and after the entire request, and to withhold completion if disposal fails. The protocol-5 stopped-worker proof is unchanged. Account-control reservations still bound the complete request, including a smaller final allowance.
- Initial Deep Think behavior and reasoning allowance are unchanged. Later visible-text continuations can use the Fast path. No hidden reasoning text is re-created or cached across HTTP requests.

## Activation order

The optional public configuration `fastReplyTokens: 512` is emitted only for exact server environment `FAST_REPLY_TOKENS=512`. Missing or invalid settings retain the current 256-token behavior. The source change itself does not configure the variable. It was explicitly enabled in Production only after the reviewed gateway rollout; removing the option and redeploying restores the browser budget to 256.

Before activation: pass both Samsung builds/SEO, the full test suite, actual native-stream cancellation/cleanup and account-stack checks, required CI, and a bounded comparison on the exact selected weights/runtime/template. Preserve 1.0 CPU, 2 threads, memory/swap bounds, the 75°C experiment guard and the existing runtime thermal guard. Validate representative full replies and the 270-second proxy deadline. A short successful pair alone does not approve longer sustained generation. Deploy the tested native gateway before enabling the larger browser request budget; preserve rollback and prove live Stop/Retry/temporary-chat behavior.

If the sustained test reaches its thermal guard, leave activation off, record the result, and continue account/recovery work. Do not raise the guard or label this change a faster model or 50,000-user solution.

## Measured release evidence

Both build targets/SEO and 121 Node/four Python tests passed on the Samsung; required application/security, Docker/runtime, real SQL isolation/admission and official CLI release checks passed at `1b9096d`. An immutable COPY-only image derived from the exact serving gateway leaf passed 37 actual-image gateway/chunk tests. Gateway-only rollout preserved model and ingress container IDs, model HostConfig, credentials, startup and rollback. The runtime/database account flag remains off.

Under the pinned weights/runtime/template, 1 CPU/2 threads and 4096 context, one fixed DNS prompt reached 512 output tokens in 141.62 seconds with reuse versus 175.27 without, saving 33.64 seconds (19.2%). The internal handoff first-text wait fell from about 33 seconds to 0.30 seconds. Decode remained around 3.8 tokens/second. The candidate completed 622 tokens naturally in 229.13 seconds under the 75°C experiment guard, with a remaining 58.7-second cross-request prefill pause. A warmer baseline then hit the guard and was aborted/cleaned up; a separately cooled baseline completed 674 tokens in 276.88 seconds, peak 74°C. Whole-answer percentages are invalid because output lengths differed. This is one fixed prompt per profile, without percentile or sustained-capacity evidence.

Actual-model Stop during reused chunk 2 passed, as did a fresh NEW response after cleanup, simple arithmetic and a seasons fact check; peak 71°C. One is_even coding prompt failed to return a function under both the candidate and current budgets, with identical eight-token output hashes. It was not executed as unrestricted code or counted as a quality pass. Fixed probe replies were not retained. These observations expose an existing model-quality limitation; this release does not certify a smart coding assistant, change weights, provide GPU decoding or establish 50,000-user capacity.


## Optional third chunk (October20 candidate)

`FAST_REPLY_TOKENS=768` is a separate opt-in at the native gateway and public API. Native code defaults to512; public code defaults to256 when absent. Configure both only after the release gates pass; keep512 for rollback. Old clients requesting512 continue to receive at most512 even on the768 gateway. The three internal chunks remain individually bounded at256 and private to one active HTTP request. Context, queue, generation/proxy deadlines, erasure, account reservation and initial Deep behavior stay unchanged. No schema migration or account activation accompanies this option.

Paired fixed DNS task on the exact selected model: candidate completed632 tokens naturally in172.99s; current path completed622 tokens in230.98s. Candidate internal handoff after512 tokens was0.287s; current cross-HTTP handoff was59.104s. First text was7.37 vs7.46s. The larger request avoids repeated prompt processing; it does not improve raw decoding, first-token latency or model quality. Peak was74°C; production containers were unchanged. Different completed output lengths preclude a universal whole-answer percentage. See `evidence/request-budget-768-20261020.json`.

OpenMP PASSIVE waiting with spin counts0 and100 did not produce a material decode gain (3.8628 and3.8288 vs3.8434 tokens/s), and is not selected. See `evidence/openmp-profiles-20261020.json`. The generic MNN importer is not ready for this hybrid checkpoint: recurrent learned constants, Q5_K mapping and per-request state erasure require custom validation before inference can be compared.

Release status: candidate only until exact-source full-budget/Stop/fresh-request probes, Samsung validation, required CI and immutable image checks pass. Neither the benchmark nor this document changes production configuration.


October20 stress result: the full768-token Python-list workload reached75°C before completion. The fixture aborted and removed its container; production IDs were unchanged. Keep768 inactive and PR51draft. The successful632-token DNS sample does not override the failed worst-budget release gate. Both Samsung builds/SEO and128Node tests passed at56°C; this is correctness evidence, not thermal approval.
