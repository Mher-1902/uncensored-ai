# Request-scoped answer prefill reuse

October 20 candidate. Not production activation or a measured capacity claim.

The current browser asks for 256 output tokens at a time. Each subsequent HTTP request includes the generated answer prefix and the native gateway erases its slot before and after every request. Re-evaluating that growing prefix can create long pauses. An earlier isolated 64+64-token comparison measured 47.40 seconds when erasing between parts versus 37.45 seconds with reuse; the second-part first-text wait was 10.42 versus 0.24 seconds. Decode remained approximately 3.82 tokens/second, quality was not assessed, and peak temperature was 74°C. This is one synthetic pair per profile, not sustained or percentile evidence.

## Invariants

- Keep cache reuse entirely inside one open, exclusively acquired gateway request. Other requests wait under the existing bounded queue. No idle cache, cross-user reuse, durable prompt cache, content fingerprint or new receipt is introduced.
- Fast requests larger than 256 tokens use model chunks of at most 256. Continue only a complete length-stopped chunk with valid bounded usage and visible progress. Require the next rendered template to equal the previous template plus the exact streamed content, including code whitespace.
- Cap Fast output at 512 tokens for prompts of at most 128 tokens, otherwise preserve the 256-token allowance. A long prompt must not combine expensive prefill with a larger output budget near the proxy deadline.
- Hide internal length stops from the browser. Report one final stop/length result and aggregate newly generated tokens, charging the original prompt once. A transport error, mismatched template, invalid usage or cancellation never becomes successful DONE.
- The gateway retains its existing responsibility to erase the slot before admitting content and after the entire request, and to withhold completion if disposal fails. The protocol-5 stopped-worker proof is unchanged. Account-control reservations still bound the complete request, including a smaller final allowance.
- Initial Deep Think behavior and reasoning allowance are unchanged. Later visible-text continuations can use the Fast path. No hidden reasoning text is re-created or cached across HTTP requests.

## Activation order

The optional public configuration `fastReplyTokens: 512` is emitted only for exact server environment `FAST_REPLY_TOKENS=512`. Missing or invalid settings retain the current 256-token behavior. No variable is configured by this source change.

Before activation: pass both Samsung builds/SEO, the full test suite, actual native-stream cancellation/cleanup and account-stack checks, required CI, and a bounded comparison on the exact selected weights/runtime/template. Preserve 1.0 CPU, 2 threads, memory/swap bounds, the 75°C experiment guard and the existing runtime thermal guard. Validate representative full replies and the 270-second proxy deadline. A short successful pair alone does not approve longer sustained generation. Deploy the tested native gateway before enabling the larger browser request budget; preserve rollback and prove live Stop/Retry/temporary-chat behavior.

If the sustained test reaches its thermal guard, leave activation off, record the result, and continue account/recovery work. Do not raise the guard or label this change a faster model or 50,000-user solution.
