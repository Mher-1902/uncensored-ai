# Server-powered product pilot

October 17, 2026. This is the active implementation direction. It supersedes the browser-inference proposal in ZERO-BUDGET-SCALE.md: visitors will not download models or supply GPU compute.

Offscript is a normal account-based SaaS for technical and nontechnical users worldwide, operated from Armenia. The goal is 50,000 monthly active users, not 50,000 simultaneous generations. Prove useful answers and repeat usage with a small existing-resource pilot before proposing any paid GPU rental. No paid service, plan, trial or automatic overage is authorized.

The first release has Fast and Deep Think. Real source-backed Research, subscriptions, image generation and Cue integration follow as separate increments. Broad age access is a long-term goal; public access requires an approved age/guardian policy appropriate to the markets served. A checkbox is not proof of age or immunity from liability.

## First implementation boundary

The native gateway now accepts `mode: "fast" | "deep"`. The legacy `reasoned` boolean is accepted during transition; conflicting values are rejected. Research is not yet a valid mode. Mode names describe computation profiles, not proven intelligence or latency guarantees.

The llama adapter owns readiness, real template/token accounting, generation and state disposal. Context remains 4,096 tokens. Output budgets, thinking reserve, sampling, CPU/memory/swap limits and thermal protection remain unchanged. Model administration stays private. A future vLLM adapter must implement its own token/template/cancellation contract; substituting a base URL is insufficient.

Protocol 2 acknowledges `[DONE]` only after request-state cleanup succeeds. Broken streams and failed cleanup remain errors; an uncleared worker stops accepting inference. This permits later account admission to distinguish successful completion from an uncertain worker state. No database admission or new model engine is deployed by this increment.

## Next increments

1. Minimal account/acceptance/usage records with default-deny RLS, restricted field writes and atomic admission. Keep chat content in page/request memory, outside durable queues, database, metrics and logs.
2. A simple charcoal/Matrix-green workspace, Fast default, explicit Deep Think, accessible immediate streaming, Stop/Copy/Clear and no history sidebar. Keep the working name `offscript_`.
3. Public privacy/terms pages and server-enforced versioned acknowledgement, with real operator/contact facts before publication. Age/guardian eligibility is a separate server-side gate.
4. A controlled 10 → 30 → 100 user pilot, measuring useful completed sessions, returning accounts, latency, failure and capacity rejection without chat recording.
5. A measured, capped GPU proposal when demand warrants it. Target Fast warm p95 first text ≤3 seconds and median decode ≥15 tokens/second on chosen hardware; current Samsung measurements do not meet this target. Deep Think must show a quality benefit and terminate reliably before broad claims.

Every change uses a branch, PR, appropriate checks and a rollback path. Existing production remains intact while replacements are validated. The deeper audit and external Grafana setup remain deferred; routine authentication, RLS, validation and dependency checks are release requirements.
