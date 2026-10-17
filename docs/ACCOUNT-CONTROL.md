# Account control foundation

This increment supplies a migration and real PostgreSQL isolation/concurrency tests. It is not an applied production migration or a configured login. No conversation content is stored.

## Privilege boundary

`offscript_data_owner` is a NOLOGIN, non-superuser, non-BYPASSRLS owner with explicit internal policies. All five tables enable and force RLS. Authenticated users may read their own account, policy receipts and daily totals, with no direct write grants. Anonymous users have no access. Plan/status/eligibility are server-controlled, and private lease/settings tables are not exposed.

`offscript_gateway` is a separate NOLOGIN group with access only to the parameterized functions in `offscript_api`. It has no direct table access. A dedicated login may be provisioned as a member later, with its password stored in the server secret store. Do not grant it the owner role, superuser, BYPASSRLS, or expose the SQL API schema through PostgREST. No password appears in the migration.

The API must pass the subject from verified authentication to these functions, never a request-body user ID. Calling SQL functions is a trusted server responsibility; merely adding the migration does not connect the application.

## Serving gates and accounting

New accounts start pending and with unresolved eligibility. Terms/privacy versions start as unpublished drafts. Applying the migration therefore never automatically grants serving access, approves a child's eligibility or publishes legal documents. Before activation, supply real operator/contact facts, approve age/guardian rules, publish reviewed document versions and admit the pilot cohort separately.

Admission atomically checks account status, eligibility, current acceptance, daily allowances, one active request per user and the configured global capacity. Initial limits are 10 requests/day, at most 2 Deep requests, 20,000 combined tokens/day and one global active request. These are pilot maximums, not a promise of immediate capacity or 50,000-user throughput.

A request reserves the complete 4,096-token prototype context budget, covering input plus visible/reasoning output. Final usage releases unused reservations. Unknown usage charges the conservative reservation; cancellation after work starts counts as usage. Pre-start rejection can refund it. Settlement is idempotent.

Expired or uncertain leases do **not** automatically free capacity. The worker must be confirmed stopped, then the trusted gateway reconciles the lease. This prevents serverless retries or connection loss from oversubscribing a still-running model. Database failure must reject new admission. Never discard a live lease just to make the dashboard green.

Terminal request metadata can be pruned after 24 hours and daily totals after 35 days, preserving totals associated with uncertain work. Schedule the prune function only after activation. Account deletion cascades through its metadata; the API must first stop any active work before deleting the Auth identity. No prompts/replies, IPs, birth dates, identity documents or payment details are introduced here.

## Authenticated API integration

`PILOT_ACCOUNT_CONTROL=true` enables the account/acceptance routes and admission around chat. It is off by default; misspelled flag values fail closed. No production flag, migration or credential has been configured by this increment. The public `/api/*` routing and internal service binding remain unchanged.

`GET /api/account` uses the verified Supabase subject. `POST /api/acceptance` accepts only an explicit `accepted: true` and the current terms/privacy version identifiers; extra ownership or plan fields are rejected. Database policy checks remain authoritative. Neither endpoint returns prompts, identity-provider tokens or credentials.

The gateway lazily opens a PostgreSQL pool of at most two connections per instance. It requires a dedicated `offscript_runtime` login, membership in `offscript_gateway`, no owner membership or administrative/BYPASSRLS privileges, a managed Supabase host and verified TLS. SQL calls bind values as parameters. Use the Supabase transaction-pooler connection for serverless deployment, with unnamed queries. `PILOT_DATABASE_URL` is a server secret; its query string cannot override TLS. A required public CA certificate can be supplied through `PILOT_DATABASE_CA`; certificate verification must remain enabled. Do not use the project-owner database login or a Supabase service-role key.

The native worker's protocol 3 confirms cleanup on successful completion and controlled rejection/failure. Chat preflights this protocol, reserves a database lease before forwarding messages, and sends browser `[DONE]` only after cleanup confirmation and successful accounting. Unconfirmed disconnects, failed cleanup and uncertain database writes retain capacity. Unknown token usage charges the reserved context conservatively. Internal worker-control frames are removed before reaching the browser. Recognized account failures receive fixed public wording; database diagnostics are never forwarded.

Cancellation without a cleanup acknowledgement requires operator reconciliation; this increment intentionally does not guess that the worker stopped or expire the lease automatically. A reliable private cancellation/reconciliation flow is still an activation prerequisite for a usable pilot, alongside the acceptance UI and linked final legal pages. Do not enable enforcement on the existing protocol-1/2 worker or claim the API is already live.

## Validation and activation

`python3 scripts/test_database.py --container <id>` refuses an unlabelled container and uses only the disposable `offscript_test` database. CI has an isolated PostgreSQL service with dummy accounts and a pinned image. Tests exercise real policies, blocked field changes, current policy requirements, concurrent admission, stale/uncertain leases, quotas, settlement, pruning and deletion.

The October 17 Samsung test uses rootless Docker with no network, read-only root, temporary database storage, 0.4 CPU, 512 MiB RAM and zero swap. This does not inspect or load-test the production Supabase project. Provider-role compatibility and migration application must be verified before activation. Keep account enforcement disabled until the API integration, reviewed policies, restricted database login and pilot admissions are all configured; when enabled, missing configuration fails closed.
