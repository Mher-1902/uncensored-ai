# Automatic answers and account admission

Implementation contract. Not an activated feature. Migration `202610170002_logical_answers.sql` was owner-approved and installed on October 18. The protocol-5 runtime/browser integration and failure tests passed in PR #30, but remain staged. The currently deployed worker-request bridge would count automatic continuations as separate daily requests. Keep PILOT_ACCOUNT_CONTROL disabled until the logical-answer runtime is deployed and the remaining credential, policy/eligibility, recovery and retention gates are complete.

## Required behavior

One Send consumes one request allowance, and at most one Deep allowance. Continuations neither create synthetic user messages nor consume another request count. Stop, failed generation and unknown usage still count work that actually started. Confirmed pre-start rejection can refund admission. A long answer must not bypass token, context or global-capacity bounds.

Reserve the existing 4096-token logical-answer budget once. Charge its initial prompt plus every segment's newly generated tokens, including initial hidden reasoning. Subsequent repeated prompt evaluation is an internal compute cost, not another user request or a second charge for the same conversation prefix. Each next segment's output allowance is bounded by the remaining reservation as well as the actual model context; the worker must accept a smaller final allowance. Unknown usage cannot authorize another segment and is conservatively charged. No conversation text or content fingerprint is written to the database.

## Content-free state

Add a private, forced-RLS logical-answer record bound to the verified account. Store a random answer ID, original mode/day, reservation, consumed-token counts, segment count, last request ID, state, and continuation deadline. Keep individual worker request IDs/process IDs/outcomes for cleanup proof and replay rejection. No prompt/reply, raw OAuth token, IP, date of birth or durable prompt queue belongs here.

The bridge creates the first answer ID. A continuation must present the opaque receipt issued after the immediately previous segment was settled. The database verifies the same owner, a completed previous worker, a length finish reason, an unexpired waiting state and an unused predecessor. Atomically consume that predecessor so parallel/replayed continuations cannot start two workers. A client boolean alone never waives request accounting. A fresh untracked answer cannot claim to be a continuation.

## Segment lifecycle

1. Verify the session and preflight the native worker. Atomically reserve one logical answer, one account slot and one global slot before dispatch.
2. Register a new worker request/process ID and deadline. Generate only within both the context and remaining logical-token allowance.
3. Require matching worker cleanup proof and validated usage before recording the segment complete. A natural stop settles the answer and releases remaining reservation/capacity.
4. A length stop with output, budget and a segment count below 16 moves the answer to waiting. Its worker is already confirmed stopped, but the logical slot remains reserved during the immediate continuation handoff. Return only an opaque continuation receipt to the browser.
5. Start the next segment only by atomically consuming that waiting receipt. Continue the exact assistant prefix without starting another thinking phase.
6. Stop marks the answer cancelled. Waiting answers can settle immediately because their last worker is proven stopped. Active answers require the existing authenticated private cancellation/cleanup acknowledgement. Late segments must observe the cancelled state and fail before dispatch.
7. An expired waiting handoff can release capacity after 30 seconds because its previous worker was confirmed stopped and no next dispatch was admitted. Do this under the same admission lock. Active/uncertain work must never be released merely because a deadline passed.

The browser keeps partial text on every failure. Receipt/cleanup/accounting failure must not become a successful final answer. The user may start a new question after a real allowance/context limit, but no artificial Brief/Balanced/Detailed control or manual continuation prompt is reintroduced.

## Recovery and retention

Retain uncertain worker metadata until proof of cancellation or an operator-confirmed stop of both the affected gateway and model container. A changed gateway-process ID alone is insufficient evidence that model computation stopped. The operator procedure must verify the actual Docker process/cgroup stop before reconciling uncertain reservations; it must never fabricate a normal worker receipt.

Prune finished worker/answer metadata after 24 hours and daily aggregates after 35 days. Expire only known-stopped waiting handoffs automatically; retain active/uncertain leases. Schedule cleanup only once the migration and restricted runtime are configured. Account deletion must stop/reconcile active work before removing the Auth identity and cascading metadata.

## Validation gate

Use real disposable PostgreSQL with two accounts and competing connections, plus the offline native/runtime fixture. Test one allowance across several segments, hidden-token accounting, no double charge for prefill, token-budget clamp, current policies/eligibility, stolen-owner and replayed receipts, two racing continuations, Stop between/during segments, disconnect before/after settlement, stale worker IDs, unknown usage, database failures, safe waiting expiry, unresolved active retention and account deletion. Confirm no conversation columns or logs are introduced. Run authenticated browser QA with dummy/local fixtures before production enforcement.

This specification adds no 50,000-user capacity claim. The current Samsung still has one CPU inference slot; admission controls keep overload bounded rather than creating more compute.

## Database implementation

The second migration adds private forced-RLS answer and segment metadata. Admission and settlement share the foundation's settings lock. It issues owner-bound single-use continuation receipts only after known worker cleanup and validated token usage, holds capacity across the 30-second handoff, and disables the gateway's legacy per-worker admission functions. Initial Deep accounting includes the engine's additional thinking-token budget. A deletion trigger blocks Auth/account cascades while computation is active, waiting or uncertain; the deletion workflow must cancel and settle first.

Both migrations and the restricted NOLOGIN runtime role are installed in the managed project; see [DATABASE-RELEASES.md](DATABASE-RELEASES.md). Eleven read-only live checks passed after the October 18 release. Runtime credential creation, protocol-5 deployment, policy/eligibility activation, operator reconciliation and retention scheduling remain separate release gates.
