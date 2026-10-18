# Product worklist

Updated October 17, 2026. This file is the persistent work queue. Record new owner requests here while implementation continues; do not silently drop or restart existing work. Address the current release blockers first, then queued additions. Mark a task complete only with source, test and release evidence.

## Current owner requirements

- Preserve the original illustrated website and underscore in `offscript_`. Avoid another wholesale redesign.
- Compact composer controls and remove unnecessary public implementation details, the “A CONVERSATION. NOT A RECORD.” line and technical About panel.
- Model responses must visibly use a terminal monospace font and bright green on a black/dark terminal background. Owner supplied #00FF00 / #61cf5a and classic/modern monospace examples. Verify a fresh production page; existing tabs retain their loaded UI and must not be reloaded if they contain a user's temporary conversation.
- Deliver complete answers without making users manually choose a reply length or ask “continue” after an artificial cap. Do not disguise truncated output as completed. Real context, timeout, cancellation, quota and hardware limits still need honest handling.
- Measure and improve inference latency. The Samsung remains the backend host. No paid provider, plan, trial, GPU, hardware purchase or automatic overage is authorized. Do not claim 50,000-user capacity or GPU-level speed without evidence.
- Persistent accounts, ephemeral chats, Fast and Deep Think first; source-backed Research, subscriptions, image generation and Cue later.
- Finish the staged account admission/RLS, policy acknowledgement UI and linked policies, restricted database provisioning, cancellation/recovery and retention activation. User supplied public operator Mher Sukiasyan, sukiasyanmher7@gmail.com, operator country Armenia. On October 17 the owner confirmed the Samsung is physically in Latvia. Preserve the broad-audience direction and implement applicable age/guardian safeguards; do not repeatedly ask the same age question or silently invent an adults-only default.
- Use incremental GitHub branches, PRs and CI. Keep Docker and remote Samsung development. Preserve keys, existing files and working production services. Full security audit/Daybreak and external Grafana remain deferred.

## Current infrastructure facts

The Samsung in Latvia currently runs the CPU LLM and private gateway and is still required for working replies. Vercel serves the website/API; Supabase provides Auth/PostgreSQL (Paris). Vercel API/gateway functions were observed in IAD1 (United States). No external GPU inference service has been connected and no Samsung role has been retired. A future supported GPU host may replace its inference role; the Samsung could then remain a gateway or become optional. Do not describe that future option as an accomplished migration.

## Execution order

1. Complete and visually verify the current small UI cleanup; release it from the deployed UI branch without pulling in unactivated backend work.
2. Automatic answer continuation is being implemented on codex/complete-responses, together with exact assistant-prefix validation, partial-text preservation and removal of manual length controls. Validate the pinned inference runtime and roll out the native gateway first; the live frontend must not call an unsupported worker.
3. Benchmark the existing model/runtime under bounded resources; separate first-token, prefill, decode and queue latency. Apply only measured changes with thermal limits and rollback.
4. Integrate staged backend/account work with the accepted UI before any deployment. Never redeploy the old Matrix design from an older backend branch.
5. Account/acceptance/usage interface, final truthful legal pages, provider-compatible restricted database role, controlled admissions, worker recovery and metadata retention.
6. End-to-end pilot validation (authentication, isolation, ephemeral data, cancellation, response completion and measured capacity). Release a usable measured pilot; do not relabel an unproven 50,000-MAU design as validated capacity.

## Evidence already available

- Original UI restored in PR #22, source c45ec803d3cee8b1bc72e0894c79c717f86325ef; Production deployment 4agfJAX4TFSdSM3vQ6k8kf5WEQgE. Both build targets, SEO, 40 Node and 4 Python tests passed on Samsung; desktop/mobile and real sign-in/reply/Clear verified.
- Account API #19 and cancellation #21 are staged and their checks passed. They are not activated in Production. Database foundation has 31 real PostgreSQL isolation/admission checks.
- Compact controls, removal of About/slogan and #00FF00 Courier response styling: PR #23, source a8bfda51ea77137cbbd20ef049336461664da0e4; Production deployment 5B2g9H8Nwmw7ZVZ4wz2a2QgJrju2. Application CI and Vercel checks passed. Initial Samsung checks passed at /home/rog/dev/checks/compact-chat-controls-1. Additional response-completion work remains active.

## Incoming additions to do after current release blockers

Append new requests here with a short description and date. Promote them into the active sequence deliberately rather than discarding current work.

- No additional requests queued yet; the October 17 response-completion, latency and terminal-style requests are active release requirements above.

## October 17 latency experiment

Disposable offline container using the same pinned runtime, Q4_K_M model, two threads, 4096 context and synthetic two-sentence prompt. Production container was unchanged. At 0.8 CPU, warm samples measured ~4.96–4.98 seconds to first text and ~3.10–3.13 decode tokens/sec. At 1.2 CPU, two samples measured ~3.27 seconds and ~4.72–4.75 tokens/sec; peak 74°C over the run. This is a small controlled comparison, not sustained-load or p95 evidence. A preceding 1.6 CPU run aborted on a combined resource guard and produced no valid 1.6 result. Do not remove the thermal guard or claim a measured 1.6 benefit. Validate sustained 1.2 CPU behavior before any production limit change.

Account-control integration remains feature-gated. Automatic continuation currently represents several worker segments; logical-answer quota accounting must be reconciled before enabling pilot admissions, so a long answer does not silently consume a quota once per segment.


## October 18 first-use priority

The owner prioritizes fast general answers and coding. The immediate gap is predictable completion/recovery, not another redesign or provider integration. This production leaf starts from deployed source `593406a`, avoiding activation of the separately staged account/runtime stack. For new questions, it bounds the single-worker queue to one waiting request for ten seconds while preserving the existing continuation allowance. It preserves failed/stopped answers with explicit retry, excludes incomplete exchanges from later model context, and preserves a next draft typed while waiting. A delayed waiting hint appears only after sending, never while composing. Original artwork and #00FF00 Courier output remain. This improves reliability; it does not claim faster decoding, better model quality or 50,000-user capacity.

Next product gates: evaluate general-answer/coding usefulness and first-token/full-answer latency on a small fixed benchmark; integrate reviewed delivery branches deliberately; finish account lifecycle, truthful policy/eligibility flows, recovery/retention and restricted runtime activation; validate capacity before expanding access. Keep no saved chats and the zero-paid-provider constraint.
