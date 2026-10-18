# Account control and answer admission

The RLS foundation was approved and applied to the existing Supabase project on October 17. Its eleven live permission/configuration checks passed; see [DATABASE-RELEASES.md](DATABASE-RELEASES.md) for the source/hash and migration-history gate. The logical-answer migration and protocol-5 runtime in this branch are staged. Production enforcement remains off. No runtime password, published policy, serving eligibility or chat database is created by this increment.

## Privilege boundary

`offscript_data_owner` is a NOLOGIN, non-superuser, non-BYPASSRLS owner with explicit internal policies. The foundation's five tables enable and force RLS. Authenticated users can SELECT only their own account, policy receipts and daily totals; they cannot write plan, ownership, status or eligibility. Anonymous users have no access. Migration 002 adds two private forced-RLS answer/segment metadata tables.

`offscript_gateway` is a separate NOLOGIN group with parameterized functions in private `offscript_api` and no direct table access. Never expose this schema through PostgREST. The opt-in [runtime provisioning script](../supabase/admin/provision_runtime.sql) prepares `offscript_runtime` as a member of this group, initially **NOLOGIN**, with no password. It must never join the owner role or acquire administrative, BYPASSRLS or replication privileges. Neither migration contains a password. Migration 002 revokes the gateway's legacy per-worker reserve/finish functions.

### Private runtime provisioning

The administrator script is deliberately outside `supabase/migrations`: a normal deployment must not create or rotate application credentials. Review and apply it separately after the required schema release. It uses one atomic DO statement so extended-query clients, including the official CLI query command, can execute it. It refuses an existing runtime role rather than overwriting its password or permissions. Its only membership is `offscript_gateway`; it grants CONNECT to the current database, caps backend connections at six and sets a `pg_catalog` search path, four-second statement timeout, 1.5-second lock timeout and five-second idle-transaction timeout. These are pilot bounds, not a capacity claim.

Credential activation is a separate owner-operated step. Set a strong unique password privately using a trusted PostgreSQL client's masked password facility, enable LOGIN only after verifying privileges, and enter the resulting restricted transaction-pooler URL directly into Vercel's server-only `PILOT_DATABASE_URL` secret. Do not use the project administrator credential for the application, put passwords in SQL/source/shell history, or return them in diagnostics. Verify the pooler username and project suffix against the project's connection settings. Supply the public Supabase CA through `PILOT_DATABASE_CA` where needed; certificate and hostname verification must remain enabled. Leave `PILOT_ACCOUNT_CONTROL` off until all activation gates pass.

SQL receives the signature/issuer/audience/expiry-verified Supabase subject, never body-selected ownership. New accounts start pending with unresolved eligibility. Draft policies are unpublished. Installation grants no serving access or guardian/legal approval.

## One Send, one allowance

Admission checks status, eligibility, current acknowledgement, daily allowances, one open answer per account and global capacity under one database lock. Initial pilot ceilings are 10 requests/day, 2 Deep requests, 20,000 combined tokens/day and one global answer slot. These are bounds, not immediate capacity or a 50,000-user throughput claim.

Reserve 4,096 tokens once per logical answer. Charge its first prompt and every newly generated token, including hidden thinking. Repeated prefill is compute overhead rather than a duplicate charge. The first Deep segment's allowance includes the pinned engine's additional 256 thinking tokens. Continuations are clamped by remaining answer allowance and actual context.

A length stop can issue a random owner-bound single-use receipt only after native cleanup and validated usage. The next segment atomically consumes it and continues the exact assistant prefix in Fast mode, without another request/Deep charge. The account/global slot remains occupied during the immediate handoff. Waiting receipts expire after 30 seconds; at most 16 segments form one answer. No content, fingerprint, IP or provider credential is stored in the ledger.

Natural completion releases unused reservation. Confirmed initial pre-start rejection refunds admission; a rejected later segment retains earlier work's charge. Unknown usage cannot continue and charges conservatively. Real budget/context failures preserve partial text and never masquerade as complete answers.

## API and worker lifecycle

`PILOT_ACCOUNT_CONTROL=true` opts into the account UI, metadata routes, logical admission and public Stop endpoint. It is off by default; malformed values fail closed. Activation requires both migrations, protocol 5, a restricted runtime, published immutable policy links, eligibility flows and operational recovery/retention. Do not enable it on the current legacy production path.

- `GET /api/account` returns only the verified account's plan/status, acknowledgement and remaining allowance metadata.
- `POST /api/acceptance` accepts exactly explicit `accepted: true` and current document versions. The UI checkbox starts unchecked and requires immutable links in `src/policy-documents.ts`; its registry remains empty while documents are drafts.
- `POST /api/chat` creates random answer/request IDs server-side. Continuation also requires the previous answer ID and receipt; a boolean never waives accounting. SSE exposes answer IDs and settled continuation receipts, while stripping private worker control frames.
- `POST /api/answer/cancel` accepts only an opaque answer ID and verified session. Waiting answers settle immediately because their worker is already stopped. Active answers target the recorded native request/process and require matching cleanup proof. Responses expose no worker IDs. This covers Stop between segments.

The protocol-5 bridge prepares a cancellable worker identity through private `/api/prepare` before committing SQL admission. A prepared claim cancelled before dispatch remains aborted, so a late HTTP request cannot start inference after capacity was released. Failed admissions discard only their own unclaimed preparation; abandoned unclaimed preparations expire safely. Claimed/uncertain computation is retained. The native worker accepts a smaller final allowance only on credential-authenticated tracked requests. Ordinary callers retain bounded presets. Private `/api/cancel` requires the service credential and acknowledges claimed computation only after cleanup. Unknown requests, restarts, failed cleanup and timeouts do not prove model computation stopped.

The bridge registers `waitUntil` before database reservation and uses an independent bounded cleanup signal after browser loss/Stop. The browser also sends an independent metadata-only cancellation for an unsuccessful known answer. Sessions stay at the authentication boundary; the native model receives only its service credential and input needed for inference.

The lazy PostgreSQL pool has at most two connections per instance. It requires the exact restricted runtime role, managed Supabase host and verified TLS; all values are bound parameters. Use the transaction pooler with unnamed queries for serverless deployment. `PILOT_DATABASE_URL` is server-only and cannot override TLS through URL parameters. Optional `PILOT_DATABASE_CA` supplies a needed public CA while verification stays enabled. Never use the project-owner login or service-role key.

## Recovery, retention and deletion

Known-stopped waiting handoffs can expire under the admission lock. Active/uncertain work never expires free. The gateway/database are not a distributed transaction; platform termination or database loss can require operator reconciliation. A new gateway process is not proof the old model stopped. Recovery must verify both affected gateway/model processes or cgroups stopped before releasing uncertain work.

`prune_metadata()` expires safe handoffs, removes finished answer/worker records after 24 hours and daily aggregates after 35 days while retaining uncertain work. Scheduling and operator reconciliation remain activation gates. Account deletion must stop/settle computation first: migration 002 blocks Auth cascades while an answer or legacy lease is open. Settled metadata then cascades. No prompts/replies, birth dates, identity documents or payment details are introduced.

## Validation

`scripts/test_database.py` accepts a labelled disposable container/database or an explicitly marked isolated fixture, never production URLs/credentials. CI runs real PostgreSQL RLS/admission tests as both standard-admin and managed-project roles. These cover field tampering, quotas, admission/continuation races, receipt ownership/replay, uncertainty, pruning and deletion.

`scripts/test-cli-release.mjs` rehearses the administrator release with the official Supabase CLI 2.121.0, checking the vendor binary's SHA-256 before execution. It accepts no connection arguments, requires a fresh `offscript_test` database on isolated loopback and uses dummy credentials only. It repairs foundation history, verifies a 002-only dry-run without schema changes, deploys 002 with history, provisions the restricted NOLOGIN role through the actual CLI, checks overwrite refusal and verifies the final migration list/unpublished policies. Its separate CI job downloads a checksum-pinned vendor archive before isolating the fixture, then runs with read-only source/vendor/root, scratch HOME/tmp, dropped capabilities, no Docker socket, bounded CPU/memory and no external network. The six checks also passed on the Samsung (peak 51°C). This proves the disposable release path; it is not evidence that the managed project received migration 002.

The Samsung fixture isolates PostgreSQL and its client on private loopback, with read-only source/toolchain/root, scratch HOME/tmp, no Docker socket, 0.4 CPU/512 MiB per container, zero swap and bounded wall time. It executes the administrator provisioning script as the observed managed-project role, verifies the restricted NOLOGIN role/connection limit and checks that rerunning refuses to overwrite it. Its `scripts/test-answer-stack.mjs` additionally exercises the browser client, public binding, real bridge/native HTTP gateway and SQL ledger with a synthetic engine. This checks multi-segment Deep accounting and Stop during/between segments, not model quality or production capacity.

References: [Vercel cancellation](https://vercel.com/docs/functions/functions-api-reference#cancel-requests), [waitUntil](https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package#waituntil), [PostgreSQL role-creator membership](https://www.postgresql.org/docs/17/runtime-config-client.html#GUC-CREATEROLE-SELF-GRANT), [ownership requirements](https://www.postgresql.org/docs/17/sql-altertable.html). Background promises remain subject to function duration; no durable prompt queue is created.
