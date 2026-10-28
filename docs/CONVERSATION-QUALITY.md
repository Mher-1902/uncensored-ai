# Conversation quality repair — October 27, 2026

## Confirmed defect

The outgoing request builder accepted only completed question/answer pairs. Stopping a reply therefore dropped both the assistant's unfinished text and the user's original question. A later short follow-up could reach the model with none of the subject that was still visible on screen. This is an application bug, distinct from context-window capacity or model intelligence.

`requestHistory` now retains user statements from unsuccessful turns. Consecutive pending user turns are represented chronologically in one user message, followed by the latest request. Completed exchanges retain their exact content. Unfinished assistant text remains visible in the UI but is not promoted into completed model history. Retry uses the original raw prefix so earlier user facts survive too. No durable chat storage, model summary, silent truncation or synthetic assistant acknowledgement is introduced.

This choice deliberately excludes an unfinished answer's wording. A follow-up referring only to that partial wording may need clarification; it must not erase the user's original facts. Existing request-size and actual model-token limits remain explicit errors.

## Grounding and verbosity experiment: rejected

A short server-owned instruction was tested privately with the actual CPU model. It did not reliably induce necessary clarification or correct the coding task, and extra prompt processing increased first-answer delay. It is not included in the release. A naturally stopped answer is not necessarily correct.

Twenty-four short synthetic samples compared the current model, current model with guidance, and an official LiquidAI 1.2B QAD candidate with guidance. The candidate decoded faster but still failed the ambiguous-device clarification and small coding tasks. It is not a production replacement. Full outputs and per-request measurements are kept in the private workspace evidence, not user chat storage. The test is a small screen, not broad quality or capacity proof.

## Evaluation and replacement gate

Score relevance, retained facts/corrections, supported claims, instruction following and natural completion separately. Measure first visible answer, full useful-answer time, actual prompt/output tokens, cold/warm behavior, temperature and memory. A small synthetic screen is not a broad quality or capacity benchmark. Compare any replacement with its own official template/sampling and exact checksum; report those differences.

The current CPU-only Qwen derivative is a constrained 2B checkpoint. Reduced refusal alone does not establish quality. LiquidAI's official 1.2B QAD artifact is a free-to-evaluate candidate on existing hardware, not an activated replacement. Its license, runtime compatibility, actual output quality and lifecycle must be checked before promotion. Preserve the existing serving model and rollback while testing.

## Dependency release gate

CI reported GHSA-mrhx-c7xc-m3w5 against the Vercel SDK's external Zod dependency. A scoped npm override pins `@vercel/cli-config`'s external dependency to patched Zod 4.6.6 while preserving the SDK and its other dependencies. This intentionally supersedes the publisher's exact 4.1.11 dependency pin; it is not an upstream constraint-compatible release. The current parent patch releases still declare that old pin.

Clean install, audit and pure parser compatibility checks are required. CLI Config's published main bundle also contains bundled schema code, so replacing the external package does not certify that every embedded copy is patched. The application's public request validation does not use these CLI configuration parsers. This limited dependency update and its tests are not a complete security audit.
