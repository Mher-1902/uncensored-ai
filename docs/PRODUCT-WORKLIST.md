# Product worklist

Updated October 20, 2026. This file is the persistent work queue. Record new owner requests here while implementation continues; do not silently drop or restart existing work. Address the current release blockers first, then queued additions. Mark a task complete only with source, test and release evidence.

## October 20 phone review and checkpoint

- Requested: remove the public infrastructure/location breakdown. Simplify the shared signup/standalone privacy notice while retaining a concise service-provider disclosure. Keep server/region implementation details in operator documentation.
- Requested: bring the composer actions and Privacy/footer hints closer together. Preserve the below-button mode menu, original artwork and green terminal replies. Verify desktop, narrow mobile, keyboard use and a separately typed draft.
- Released: signup privacy and in-app welcome through PR #45, merge `48c320bc2ef8a5f91967f663843d79426370c65f`, Production `Avco5HzVGVKSFV6jEZZUAe7P6fw5`. Both builds/SEO, 107 Node and four Python tests, required application/Docker CI, and live desktop/mobile GitHub returns and welcome focus passed. Welcome email is prepared only; Google remains deferred by the owner.
- Verified October 20: the existing OAuth app 3935352 is owned by the user-controlled free `offscript-ai` organization. The repository remains `Mher-1902/uncensored-ai`; no repository transfer or credential replacement occurred. Use the organization's OAuth app settings URL rather than the old personal URL.
- Inference speed and account activation remain in progress. Preserve the 75°C experiment guard, existing serving containers, no saved chats and zero-paid-provider constraint while the owner tests on a phone.

## Current owner requirements

- Preserve the original illustrated website and underscore in `offscript_`. Avoid another wholesale redesign.
- Compact composer controls and remove unnecessary public implementation details, the “A CONVERSATION. NOT A RECORD.” line and technical About panel.
- Model responses must visibly use a terminal monospace font and bright green on a black/dark terminal background. Owner supplied #00FF00 / #61cf5a and classic/modern monospace examples. Verify a fresh production page; existing tabs retain their loaded UI and must not be reloaded if they contain a user's temporary conversation.
- Deliver complete answers without making users manually choose a reply length or ask “continue” after an artificial cap. Do not disguise truncated output as completed. Real context, timeout, cancellation, quota and hardware limits still need honest handling.
- Measure and improve inference latency. The Samsung remains the backend host. No paid provider, plan, trial, GPU, hardware purchase or automatic overage is authorized. Do not claim 50,000-user capacity or GPU-level speed without evidence.
- Persistent accounts, ephemeral chats, Fast and Deep Think first; source-backed Research, subscriptions, image generation and Cue later.
- Finish the staged account admission/RLS, policy acknowledgement UI and linked policies, restricted database provisioning, cancellation/recovery and retention activation. User supplied public operator Mher Sukiasyan, sukiasyanmher7@gmail.com, operator country Armenia. On October 17 the owner confirmed the Samsung is physically in Latvia. Preserve the broad-audience direction and implement applicable age/guardian safeguards; do not repeatedly ask the same age question or silently invent an adults-only default.
- Use incremental GitHub branches, PRs and CI. Keep Docker and remote Samsung development. Preserve keys, existing files and working production services. Full security audit/Daybreak and external Grafana remain deferred.

## October 19 signup and growth requests

- Add a privacy summary and full expandable notice in the sign-in/create-account popup, with an accessible standalone current-processing notice. This is separate from durable Terms acceptance and eligibility activation.
- Welcome users inside the website after sign-in. The owner chose both in-app and email; prepare email for later, with no sender or marketing opt-in activated.
- Prepare a free branded GitHub organization to replace the personal OAuth owner label. The owner chose preparation; organization Terms/CAPTCHA and OAuth ownership transfer need their specific human actions/confirmation. Do not move repositories or replace credentials.
- Google sign-in is supported in code but remains provider-disabled. Google Cloud requires two-step verification, and the owner explicitly chose to leave setup pending for now.
- Research marketing channels and record practical, capacity-aware experiments in GROWTH-EXPERIMENTS.md. No campaigns or third-party tracking are authorized by the request for ideas.

## Current infrastructure facts

The Samsung in Latvia currently runs the CPU LLM and private gateway and is still required for working replies. Vercel serves the website/API; Supabase provides Auth/PostgreSQL (Paris). Vercel API/gateway functions were observed in IAD1 (United States). No external GPU inference service has been connected and no Samsung role has been retired. A future supported GPU host may replace its inference role; the Samsung could then remain a gateway or become optional. Do not describe that future option as an accomplished migration.

## Execution order

1. Preserve the verified original UI and first-answer recovery release (`25c605d`, PR #34). Stop/Retry must preserve a separately typed next draft; no user chat tab is force-reloaded.
2. Automatic answer continuation is live in PR #24, source 593406af68fc1304261774e98eb6132232cfaef1, Production 858XkfFikvUcbJ8jzE5o4dmdrbkM. Native gateway protocol 4 was deployed first; model/ingress were preserved. All CI passed. A fresh signed-in browser completed integers 1..100,END across the former cap in one message; exact text, #00FF00/Courier and no length selector/notice verified. Existing user chat tabs were preserved.
3. Benchmark the existing model/runtime under bounded resources; separate first-token, prefill, decode and queue latency. Apply only measured changes with thermal limits and rollback.
4. Validate the integration of staged account/protocol-5 work, live first-answer recovery and the approved 1.0 CPU Compose profile before reviewing the main release. Never redeploy the old Matrix design or enable account enforcement as an incidental effect of merging branches.
5. The account/acceptance/usage interface and seven-table schema are prepared; migrations 001/002 and the NOLOGIN runtime are installed. Finish private runtime activation, final truthful legal pages, eligibility/guardian flows, controlled admissions, worker recovery and scheduled metadata retention.
6. End-to-end pilot validation (authentication, isolation, ephemeral data, cancellation, response completion and measured capacity). Release a usable measured pilot; do not relabel an unproven 50,000-MAU design as validated capacity.

## Evidence already available

- Original UI restored in PR #22, source c45ec803d3cee8b1bc72e0894c79c717f86325ef; Production deployment 4agfJAX4TFSdSM3vQ6k8kf5WEQgE. Both build targets, SEO, 40 Node and 4 Python tests passed on Samsung; desktop/mobile and real sign-in/reply/Clear verified.
- Account API #19 and cancellation #21 are staged and their checks passed. They are not activated in Production. Database foundation has 31 real PostgreSQL isolation/admission checks.
- Compact controls, removal of About/slogan and #00FF00 Courier response styling: PR #23, source a8bfda51ea77137cbbd20ef049336461664da0e4; Production deployment 5B2g9H8Nwmw7ZVZ4wz2a2QgJrju2. Application CI and Vercel checks passed. Initial Samsung checks passed at /home/rog/dev/checks/compact-chat-controls-1. Additional response-completion work remains active.

## October 19 visual corrections

- Follow-up after PR #43: the owner requested the mode menu below its button. Open it beneath the composer border, reserve space in the pinned chat layout and reveal it on short mobile screens without flipping over the input. Keep draft and keyboard behavior.

- Active in PR #43: replace the native Fast / Deep Think dropdown with a dark, green-accented accessible listbox matching the composer. Keep keyboard navigation, touch/pointer selection and the current draft.
- Active in PR #43: fix the mobile illustration’s brief rectangular matte and delayed animation restart. Render the original illustration with a transparent SVG filter output; animate opacity/position from the initial stylesheet instead of a late scroll observer. Preserve the original figure, welcome layout and reduced-motion preference.
- Release only after desktop/mobile visual checks and the required CI; no backend or inference changes are included.

## Incoming additions to do after current release blockers

Append new requests here with a short description and date. Promote them into the active sequence deliberately rather than discarding current work.

- October 19: improve actual inference speed from measured general-answer/coding workloads and integrate reviewed branches into main. Reliability UI is released; it is not evidence of a decoding-speed gain. Preserve no saved chats, existing thermal limits and the zero-paid-provider constraint.

## October 17 latency experiment

Disposable offline container using the same pinned runtime, Q4_K_M model, two threads, 4096 context and synthetic two-sentence prompt. Production container was unchanged. At 0.8 CPU, warm samples measured ~4.96–4.98 seconds to first text and ~3.10–3.13 decode tokens/sec. At 1.2 CPU, two samples measured ~3.27 seconds and ~4.72–4.75 tokens/sec; peak 74°C over the run. This is a small controlled comparison, not sustained-load or p95 evidence. A preceding 1.6 CPU run aborted on a combined resource guard and produced no valid 1.6 result. Do not remove the thermal guard or claim a measured 1.6 benefit. A longer 1.2 CPU test subsequently aborted at 75°C with ample RAM, so that setting is not selected. A conservative 1.0 CPU setting completed a 384-token run in 105 seconds at ~3.83 decode tokens/sec, peak 72°C. The same short-prompt comparison measured ~3.92 tokens/sec and ~4.0 seconds to first text at 1.0 CPU, versus ~3.12 tokens/sec and ~5.0 seconds at 0.8 CPU; peak 70°C. Select 1.0 CPU with the existing memory/thermal limits and preserve rollback. These are small synthetic checks, not capacity or p95 measurements.

Account-control integration remains feature-gated. Logical-answer accounting across worker segments is installed in the database and implemented in staged protocol-5 code. Keep the legacy per-worker path disabled until that runtime is deployed and the remaining activation gates pass, so a long answer does not silently consume a quota once per segment.


## Staged account interface

The account/acknowledgement interface is prepared behind PILOT_ACCOUNT_CONTROL. It fetches only the same-origin authenticated account API, keeps the agreement unchecked and requires explicit published document links. The policy registry remains empty while drafts are unfinished, so no draft is silently treated as a binding agreement. Server eligibility/admission remains separate. Its original Samsung checks passed both builds/SEO, 69 Node and 4 Python tests, peak 59°C. Migrations 001/002 and the restricted NOLOGIN role are now installed, and continuation accounting has separate fixture evidence below. Runtime authentication, age/guardian safeguards, immutable policy publication, operator reconciliation and retention scheduling still prevent production activation.


## Database compatibility validation

The real Supabase project was inspected with metadata-only SELECTs: PostgreSQL 17.11 and a project admin that is not a superuser. A matching isolated fixture reproduced the bootstrap ownership failure. The correction adds transaction-local role-creator membership and removes temporary schema CREATE after ownership transfer. The owner approved the corrected foundation, and it was applied on October 17; all eleven live permission/configuration checks passed. Foundation history was repaired on October 18 before the separately approved logical-answer migration and NOLOGIN runtime were installed. See [DATABASE-RELEASES.md](DATABASE-RELEASES.md) for exact hashes and evidence. Keep enforcement off while private runtime credentials, protocol-5 deployment, policies/eligibility, recovery and retention remain unactivated.


Logical-answer accounting is specified in [ANSWER-ACCOUNTING.md](ANSWER-ACCOUNTING.md). The database implementation from PR #29 is installed after owner approval on October 18; all CI and eleven post-release live metadata checks passed. The tested protocol-5 runtime integration in PR #30 remains staged. Do not enable the deployed per-worker ledger around automatic continuations or claim the new accounting is serving production traffic.


## Current release / activation checkpoint

- Live website: https://offscript-ai.vercel.app/, frontend source `25c605d17168dda725e9f2fefc73aff37eee5b2d`, Vercel Production `9nuVEzNVxc3zc4R77FZtU1bwycbV`. Protected Samsung gateway source `bc228fa375b331399d0459ca72e7d426fd8a6483`, image `sha256:5841855aba06095441f5b8774790c268ceaabc3000e3226a3ef3b8293805de72`, protocol 4. Startup override persists the gateway; model, ingress and the 1.0 CPU profile were preserved. These are the October 19 pre-integration release facts, not a protocol-5 deployment.
- CPU profile PR #26, source 88dfa0f: 1.0 CPU applied in place after all CI passed. Model process/image/container, memory and thermal limits preserved. Matching systemd/Compose startup override persists it. Same-prompt synthetic decode ~3.92 vs ~3.12 tokens/sec, first text ~4 vs ~5 seconds; longer test peak 72°C. This is a modest measured local improvement, not GPU speed or capacity proof.
- Account/policy UI PR #25, source 800b429: all CI passed, feature remains off. Policy-link registry intentionally empty while documents are drafts; no legal acceptance or eligibility is fabricated.
- Provider migration PR #27, source 64302f6: managed-role fixture 33 checks, standard-admin fixture 32; all CI passed, including Docker. After explicit owner approval, the exact tested foundation was applied in the existing Supabase project; eleven live RLS/permissions/configuration checks passed. Foundation history was reconciled on October 18 before the next CLI deployment. No runtime password was created; the owner entered the administrator password privately for maintenance. Admission remains off.
- Draft #28, source 3cc254a, established the logical-answer accounting/recovery contract. PR #29 implemented the ledger and PR #30 implemented the tested runtime; their deployment/activation gates below remain separate.
- Logical-answer ledger #29: database implementation installed after separate owner approval on October 18. Migration SHA-256 is `7de0e2b762fdc5e5402267d97b4b335005cd0fc9b46eae2a952cfcb4053756e6`. Native protocol-5, browser receipt/Stop and bridge integration passed in PR #30 but remain staged; no production serving flag or service was changed by the database release.
- October 18 runtime validation: both builds/SEO, 82 Node and 4 Python tests passed in the offline Samsung container (peak 60°C). Real PostgreSQL plus the client/binding/actual native HTTP gateway passed completion, Stop during inference, Stop between segments and Stop after admission before dispatch. The last case verifies no model generation and no request/token charge. A cancellable worker preparation precedes SQL admission; late dispatches claim an aborted identity. Combined fixtures exposed and fixed cancellation classification and an unread response/timer cleanup path. This is staged protocol-5 work, not a production deployment or model-speed improvement.
- Remaining activation work: private runtime credential activation and protocol-5 rollout, immutable final policies/acknowledgement, actual age/guardian flows, operator recovery and retention scheduling. Public registration is desired, but 50,000-MAU capacity is unverified and no paid resource is authorized.
- October 18 provisioning increment, PR #31/source `0d0939231ca2579b169bb3bc940cf21bcec60987`: the opt-in administrator script creates a password-free restricted NOLOGIN runtime, refuses overwrites and fixes its connection/time limits. The final managed-project fixture passed 69 database checks and four combined stack cases (peak 59°C); five additional official CLI release-path checks passed against a separate disposable database (peak 58°C). The CLI rehearsal exposed a multi-statement query limitation; provisioning uses one atomic DO statement. All required CI passed, including Docker. After separate owner approval and private masked password entry, migration 002 and this NOLOGIN role were installed at 21:08 Riga time (18:08 UTC). Eleven independent read-only live checks returned true. The dashboard records exactly migrations 001 and 002. No runtime password/login, policy publication or serving flag was activated.
- The official CLI release rehearsal is captured in `scripts/test-cli-release.mjs` and a separate isolated database CI job, PR #32/source `1f619ac`. Six checks passed locally on the Samsung (peak 51°C) and in GitHub CI, including dry-run non-mutation and existing-role preservation. All required CI passed, including Docker. The vendor archive and executable are checksum pinned, the connection accepts only the disposable fixture, and no project credential enters CI.
- Post-release verification: the live website/backend is ready on native protocol 4; sign-in is required and account enforcement is disabled. The original illustrated UI and model/ingress were preserved. PR #34 passed 72 Node and four Python tests, both builds/SEO, all required CI and 28 checks in the exact native image. Fresh signed-in browser tests confirmed Stop/Retry preserve a different next draft without submitting it, followed by completed coding/arithmetic replies and #00FF00 Courier styling. Database installation is complete; application activation gates remain open.

## October 18 first-use priority

The owner prioritizes fast general answers and coding. The first reliability increment was released separately from the staged account/runtime stack in PR #34, starting from deployed source `593406a`. For new questions, it bounds the single-worker queue to one waiting request for ten seconds while preserving the existing continuation allowance. It preserves failed/stopped answers with explicit retry, excludes incomplete exchanges from later model context, and preserves a next draft typed while waiting. A delayed waiting hint appears only after sending, never while composing. Original artwork and #00FF00 Courier output remain. This improves reliability; it does not claim faster decoding, better model quality or 50,000-user capacity.

Next product gates: evaluate general-answer/coding usefulness and first-token/full-answer latency on a small fixed benchmark; integrate reviewed delivery branches deliberately; finish account lifecycle, truthful policy/eligibility flows, recovery/retention and restricted runtime activation; validate capacity before expanding access. Keep no saved chats and the zero-paid-provider constraint.

Production interaction testing caught a Stop-to-Send DOM reuse race: after Stop, the button could become a submit control soon enough to send a separately typed next draft. Source `25c605d` cancels the click default and uses separate keyed controls with explicit button types. A fresh signed-in production browser verified the corrected interaction. Repeat it after integration changes, not only in reducer tests.


## October 19 integration branch

`codex/pilot-integration` combines staged source `d23180f`, the live reply-recovery/Stop source `25c605d` and CPU profile `88dfa0f` through merge commits. It preserves the exact installed migrations and NOLOGIN administrator script. Protocol-5 preparation, bounded final tokens and logical receipts coexist with the current retry/draft outcomes and the bounded new-question queue. A retry checks the original mode's allowance; it does not use a subsequently changed selector.

This branch is a release candidate, not deployed evidence. Run Samsung application/Docker/database/combined-stack checks and review the main PR before publishing it. `PILOT_ACCOUNT_CONTROL` remains off by default; the runtime remains NOLOGIN without a password, policy links remain empty and drafts remain unpublished. A main merge must not silently activate database access, the old backend deployment workflow or a new model. Preserve the existing Production release for rollback and confirm provider automation before merging.

The next account increments can prepare recovery proof, retention scheduling and deletion lifecycle tests without credentials. Live runtime authentication requires a separate private owner handoff; final policy/eligibility publication and controlled admission remain separate actions. Actual inference speed and model usefulness still need evaluation, and no 50,000-user capacity has been demonstrated.
