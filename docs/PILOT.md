# Server-powered product pilot

October 17, 2026. This is the active implementation direction. It supersedes the browser-inference proposal in ZERO-BUDGET-SCALE.md: visitors will not download models or supply GPU compute.

Offscript is a normal account-based SaaS for technical and nontechnical users worldwide, operated from Armenia. The goal is 50,000 monthly active users, not 50,000 simultaneous generations. Prove useful answers and repeat usage with a small existing-resource pilot before proposing any paid GPU rental. No paid service, plan, trial or automatic overage is authorized.

The first release has Fast and Deep Think. Real source-backed Research, subscriptions, image generation and Cue integration follow as separate increments. The owner reconfirmed a broad audience on October 17; do not silently replace that direction with an adults-only default. Applicable age/guardian requirements still need concrete safeguards before admitting affected cohorts. A checkbox is not proof of age or immunity from liability, and the current implementation does not certify unrestricted child access.

## First implementation boundary

The native gateway now accepts `mode: "fast" | "deep"`. The legacy `reasoned` boolean is accepted during transition; conflicting values are rejected. Research is not yet a valid mode. Mode names describe computation profiles, not proven intelligence or latency guarantees.

The llama adapter owns readiness, real template/token accounting, generation and state disposal. Context remains 4,096 tokens. Output budgets, thinking reserve, sampling, CPU/memory/swap limits and thermal protection remain unchanged. Model administration stays private. A future vLLM adapter must implement its own token/template/cancellation contract; substituting a base URL is insufficient.

Protocol 4 acknowledges cleanup on successful completion and controlled failure; `[DONE]` follows cleanup. Broken streams and failed cleanup remain errors; an uncleared worker stops accepting inference. The account API can reserve capacity before generation and settle the database before acknowledging completion, while treating disconnects as uncertain. These changes are tested source increments; no database admission or new model engine is deployed yet.

## Next increments

The owner requested restoration of the original picture, layout, background and welcome motion on October 17. Keep that visual design. Responses render immediately in bright terminal green (`#00ff41`) and classic Courier monospace; Fast is the default, with Deep Think as an explicit choice. The owner also requested compact controls and removal of the technical About panel and “A CONVERSATION. NOT A RECORD.” slogan. The frontend no longer requests model health just to populate a removed panel. The client sends explicit mode plus its matching legacy flag while the serving gateway transitions.

1. Minimal account/acceptance/usage records with default-deny RLS, restricted field writes and atomic admission. Keep chat content in page/request memory, outside durable queues, database, metrics and logs.
2. The original picture-led workspace, terminal-green monospace model output, Fast default, explicit Deep Think, accessible immediate streaming, Stop/Copy/Clear and no history sidebar. Keep the working name `offscript_`.
3. Public privacy/terms pages and server-enforced versioned acknowledgement, with real operator/contact facts before publication. Age/guardian eligibility is a separate server-side gate.
4. A controlled 10 → 30 → 100 user pilot, measuring useful completed sessions, returning accounts, latency, failure and capacity rejection without chat recording.
5. A measured, capped GPU proposal when demand warrants it. Target Fast warm p95 first text ≤3 seconds and median decode ≥15 tokens/second on chosen hardware; current Samsung measurements do not meet this target. Deep Think must show a quality benefit and terminate reliably before broad claims.

Every change uses a branch, PR, appropriate checks and a rollback path. Existing production remains intact while replacements are validated. The deeper audit and external Grafana setup remain deferred; routine authentication, RLS, validation and dependency checks are release requirements.


## Automatic answer completion increment

The API-backed website no longer asks visitors to choose a reply length. It generates bounded 256-token visible-answer segments, then automatically continues the exact assistant prefix when the model reports `finish_reason: length`. The next segment is an assistant continuation, not an invented user message. Deep Think has an explicit 256-token thinking budget on the pinned runtime; later segments continue visible content without restarting hidden reasoning. Template token accounting uses the same continuation options as generation and adapts the final segment to the remaining 4,096-token context. Stop, network failure, quotas and context exhaustion remain real limits; partial text stays visible and is never passed off as a confirmed complete answer.

This increment integrates the approved illustrated interface with staged cancellation/account code. Account enforcement remains disabled pending provisioning, policy/eligibility/recovery and continuation-aware quota accounting. Do not enable it simply because the code builds. Native gateway deployment must precede the new frontend. Existing browser chat tabs retain their loaded code and must not be force-reloaded.

Validation: both build targets/SEO, 64 Node tests and 4 Python tests passed in the offline Samsung sandbox (peak 67°C). A separate disposable model instance verified the actual pinned runtime's assistant continuation contract and a 16-token test thinking budget ending in the correct arithmetic answer, with slot erasure between requests (peak 66°C). This is a protocol check, not a model-quality or multi-user benchmark.
