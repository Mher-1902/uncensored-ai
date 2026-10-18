# Product worklist

Updated October 18, 2026. This file is the persistent work queue. Record new owner requests here while implementation continues; do not silently drop or restart existing work. Address the current release blockers first, then queued additions. Mark a task complete only with source, test and release evidence.

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
2. Automatic answer continuation is live in PR #24, source 593406af68fc1304261774e98eb6132232cfaef1, Production 858XkfFikvUcbJ8jzE5o4dmdrbkM. Native gateway protocol 4 was deployed first; model/ingress were preserved. All CI passed. A fresh signed-in browser completed integers 1..100,END across the former cap in one message; exact text, #00FF00/Courier and no length selector/notice verified. Existing user chat tabs were preserved.
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


## Staged account interface

The account/acknowledgement interface is prepared behind PILOT_ACCOUNT_CONTROL. It fetches only the same-origin authenticated account API, keeps the agreement unchecked and requires explicit published document links. The policy registry remains empty while drafts are unfinished, so no draft is silently treated as a binding agreement. Server eligibility/admission remains separate. Samsung checks: both builds/SEO, 69 Node and 4 Python tests, peak 59°C. This interface is not activated; real database provisioning, age/guardian safeguards, immutable policy publication, continuation-aware accounting, operator reconciliation and retention still remain.


## Database compatibility validation

The real Supabase project was inspected with metadata-only SELECTs: PostgreSQL 17.11 and a project admin that is not a superuser. A matching isolated fixture reproduced the bootstrap ownership failure. The correction adds transaction-local role-creator membership and removes temporary schema CREATE after ownership transfer. The owner approved the corrected foundation, and it was applied on October 17; all eleven live permission/configuration checks passed. See [DATABASE-RELEASES.md](DATABASE-RELEASES.md) for the exact hash and migration-history gate. Keep enforcement off while private runtime provisioning, logical-answer accounting, policies/eligibility, recovery and retention remain unactivated.


Logical-answer accounting is specified in [ANSWER-ACCOUNTING.md](ANSWER-ACCOUNTING.md). The staged database implementation is in PR #29, source 573c49b: 67 managed-project and 66 standard-admin checks passed locally, and all application/database/Docker/Vercel checks passed. Runtime integration is in progress. Do not enable the deployed per-worker ledger around automatic continuations or claim the new accounting is active.


## Current release / activation checkpoint

- Live website: https://offscript-ai.vercel.app/, source 593406af68fc1304261774e98eb6132232cfaef1. Protected Samsung gateway image sha256:52096327b90486adfa5203d2bf3deb6715bb8954aa50207d80f48bfbb6815605, protocol 4. Native and Vercel releases verified; startup overrides persisted.
- CPU profile PR #26, source 88dfa0f: 1.0 CPU applied in place after all CI passed. Model process/image/container, memory and thermal limits preserved. Matching systemd/Compose startup override persists it. Same-prompt synthetic decode ~3.92 vs ~3.12 tokens/sec, first text ~4 vs ~5 seconds; longer test peak 72°C. This is a modest measured local improvement, not GPU speed or capacity proof.
- Account/policy UI PR #25, source 800b429: all CI passed, feature remains off. Policy-link registry intentionally empty while documents are drafts; no legal acceptance or eligibility is fabricated.
- Provider migration PR #27, source 64302f6: managed-role fixture 33 checks, standard-admin fixture 32; all CI passed, including Docker. After explicit owner approval, the exact tested foundation was applied in the existing Supabase project; eleven live RLS/permissions/configuration checks passed. No runtime password or production database credential has been created or read. Admission remains off; reconcile manual migration history before any automated database deployment.
- Draft #28, source 3cc254a: logical-answer accounting/recovery specification only. Implement it and its failure/concurrency tests before activating the existing per-worker quota ledger.
- Logical-answer ledger #29, source 573c49b: database implementation staged, with all checks passed. It is not applied to Supabase. The approved migration was the foundation only. Native protocol-5, browser receipt/Stop and bridge integration are being validated on a separate branch; no production flag or service was changed.
- October 18 runtime validation: both builds/SEO, 82 Node and 4 Python tests passed in the offline Samsung container (peak 60°C). Real PostgreSQL plus the client/binding/actual native HTTP gateway passed completion, Stop during inference, Stop between segments and Stop after admission before dispatch. The last case verifies no model generation and no request/token charge. A cancellable worker preparation precedes SQL admission; late dispatches claim an aborted identity. Combined fixtures exposed and fixed cancellation classification and an unread response/timer cleanup path. This is staged protocol-5 work, not a production deployment or model-speed improvement.
- Remaining activation work: logical-answer ledger, restricted runtime provisioning, immutable final policies/acknowledgement, actual age/guardian flows, operator recovery and retention scheduling. Public registration is desired, but 50,000-MAU capacity is unverified and no paid resource is authorized.
- October 18 provisioning increment: the opt-in administrator script now creates a password-free restricted NOLOGIN runtime, refuses overwrites and fixes its connection/time limits. The final managed-project fixture passed 69 database checks and four combined stack cases (peak 59°C); five additional official CLI release-path checks passed against a separate disposable database (peak 58°C). The CLI rehearsal exposed a multi-statement query limitation; provisioning now uses one atomic DO statement. No production runtime role or credential was created. The official, checksum-verified Supabase CLI and dashboard-provided public CA are ready on the Samsung. After owner-only masked password entry, official foundation history repair completed at 17:19 UTC and the dashboard independently confirmed the sole `202610170001`/`pilot_accounts` entry. Migration 002 remains pending; admission stays off. Do not infer later schema/credential activation from this history repair.
