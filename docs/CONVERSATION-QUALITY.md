# Conversation quality repair — October 27, 2026

## Confirmed defect

The outgoing request builder accepted only completed question/answer pairs. Stopping a reply therefore dropped both the assistant's unfinished text and the user's original question. A later short follow-up could reach the model with none of the subject that was still visible on screen. This is an application bug, distinct from context-window capacity or model intelligence.

`requestHistory` now retains user statements from unsuccessful turns. Consecutive pending user turns are represented chronologically in one user message, followed by the latest request. Completed exchanges retain their exact content. Unfinished assistant text remains visible in the UI but is not promoted into completed model history. Retry uses the original raw prefix so earlier user facts survive too. No durable chat storage, model summary, silent truncation or synthetic assistant acknowledgement is introduced.

This choice deliberately excludes an unfinished answer's wording. A follow-up referring only to that partial wording may need clarification; it must not erase the user's original facts. Existing request-size and actual model-token limits remain explicit errors.

## Grounding and verbosity

The server owns a short instruction to follow the current conversation, answer concisely unless detail is requested, acknowledge uncertainty and ask one essential clarifying question instead of inventing facts. It explicitly has no live web or device access. The same instruction is included once in template preparation/token accounting and once in each generation payload, including exact assistant-prefix continuations. Public clients still cannot supply a system role.

This guidance is not a new knowledge source or proof of reliable reasoning. Do not shorten the hard output allowance and then label a truncated answer complete. Keep natural-stop completion, continuation, cancellation, erasure and truthful error outcomes.

## Evaluation and replacement gate

Score relevance, retained facts/corrections, supported claims, instruction following and natural completion separately. Measure first visible answer, full useful-answer time, actual prompt/output tokens, cold/warm behavior, temperature and memory. A small synthetic screen is not a broad quality or capacity benchmark. Compare any replacement with its own official template/sampling and exact checksum; report those differences.

The current CPU-only Qwen derivative is a constrained 2B checkpoint. Reduced refusal alone does not establish quality. LiquidAI's official 1.2B QAD artifact is a free-to-evaluate candidate on existing hardware, not an activated replacement. Its license, runtime compatibility, actual output quality and lifecycle must be checked before promotion. Preserve the existing serving model and rollback while testing.
