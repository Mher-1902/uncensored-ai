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
2. Remove manual answer-length controls and implement/test automatic completion handling. Preserve partial text on interruption and never silently claim a complete answer.
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
