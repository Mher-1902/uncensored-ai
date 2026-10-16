# Stack and scaling decisions

**October 17 decision:** use the [server-powered pilot](PILOT.md). The owner explicitly rejected visitor model downloads and selected a normal SaaS, 50,000 MAU, a zero-spend validation pilot, and later owner-approved rental when demand warrants it. The earlier [zero-budget browser proposal](ZERO-BUDGET-SCALE.md) is historical, not the chosen implementation.

Researched against official project documentation on October 13, 2026. These are recommendations for this product and hardware, rather than an independent benchmark ranking. Offscript remains a working name; Cue integration comes later.

Development and backend execution belong on the Samsung. The Mac provides remote management. Docker Desktop may stay installed and stopped; production must not depend on a Mac process, mounted Mac directory, SSH forwarding session or desktop Docker context.

## Selected direction

The owner chose **managed Supabase/PostgreSQL** for future accounts and product data. Supabase combines PostgreSQL, Auth and database authorization through RLS. Keep production and development projects separate, with schema migrations and isolation tests in Git. The owner created the Free `Mher Projects` organization and shared project reference `pgyfliwdlonitlhzmmsj`; its development role and identity settings still need inspection. No database migration or paid service has been provisioned by this work. [Supabase database](https://supabase.com/docs/guides/database/overview), [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security).

| Need | Tool and decision | Adoption stage |
| --- | --- | --- |
| Server containers | Rootless Docker Engine + Compose; resource limits and private networking | Samsung development backend active; final startup checks in progress |
| Incremental delivery | GitHub Actions, Dependabot, reviewed PRs and immutable image digests in GHCR | Build/security CI active; production delivery needs configuration |
| Accounts and persistent data | Supabase Auth + managed PostgreSQL; reviewed RLS and SQL migrations | Owner selected; implement before user accounts launch |
| Database policy tests | Supabase CLI and pgTAP; owner/other-user/anonymous isolation tests | Add with the first schema migration |
| Browser behavior | Playwright for login, cancellation, streaming and logout paths | Add with account/API integration |
| Load and capacity | Grafana k6 for gateway traffic; existing real-model benchmark for token latency | Add before inviting real users |
| Host monitoring | Node Exporter with external Prometheus/Grafana; Alloy when outbound collection is needed | Planned; external endpoint and credentials still needed |
| Cross-service tracing | OpenTelemetry, with sampled metadata-only spans | Add when GPU/database services are integrated |
| Container and configuration security | Trivy for vulnerabilities/misconfiguration, plus SBOMs and signature/provenance checks | Next image-delivery increment |
| Secret detection | Evaluate a pinned stable Betterleaks release using offline detection and redacted output | Next security increment |
| Image generation | ComfyUI + maintained ComfyUI-GGUF on separate authenticated GPU workers | Near future; validate selected model/workflow/license first |
| Cloud infrastructure | OpenTofu for versioned compute/network configuration once a provider is chosen | Later, when moving beyond the single server |

The owner wants an iPad as the future Grafana display. The proposed path is a small metrics collector on the Samsung sending over authenticated HTTPS to Grafana Cloud, with the iPad opening private dashboards in Safari. Mac and iPad uptime do not control collection. This phase is explicitly deferred: no Grafana account, collector or remote-write integration has been configured. [Grafana Linux Server integration](https://grafana.com/docs/grafana-cloud/observe-and-act/monitor-infrastructure/integrations/integration-reference/integration-linux-node/).

Docker supports publishing images through GitHub Actions/GHCR. The delivery target should be an immutable digest with a tested previous digest for rollback. PR jobs receive no production credentials. [Image publication](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images).

Supabase supports SQL database tests with pgTAP; Playwright exercises real browser flows; k6 supplies load-test tooling. These complement the existing mocked gateway tests and real-model timings. They do not substitute for one another. [Database testing](https://supabase.com/docs/guides/database/testing), [Playwright](https://playwright.dev/docs/intro), [k6](https://grafana.com/docs/k6/latest/).

Trivy covers image vulnerabilities, secrets and configuration checks. Before enforcement, pin the scanner, triage existing findings, and give any exception an owner and expiry. Gitleaks' maintainer now limits it to security patches and directs new development toward Betterleaks. Betterleaks' main documentation currently includes v2 changes, so use a verified stable release rather than copying unstable CLI examples. Keep credential validation/revocation disabled for ordinary CI scans. [Trivy](https://trivy.dev/docs/latest/guide/), [Gitleaks maintenance](https://github.com/gitleaks/gitleaks), [Betterleaks](https://github.com/betterleaks/betterleaks).

Alloy can collect telemetry for external systems; OpenTelemetry provides the instrumentation standards. Start with host/service health and bounded-cardinality counters. Do not send prompts, replies, audio, screenshots, access tokens or full request URLs. Keep heavy dashboards, metrics storage and tracing storage off the Samsung. [Alloy](https://grafana.com/docs/alloy/latest/introduction/), [OpenTelemetry](https://opentelemetry.io/docs/what-is-opentelemetry/).

## Persistence boundary

Start with account identity, user preferences, entitlements and aggregate quota/job metadata when those features are implemented. Chats remain ephemeral. Image retention and any future Cue recording retention need explicit product decisions before storage is added.

For each user-owned table, enable RLS, restrict grants, and use the authenticated subject as ownership. Test all CRUD operations for owner, another user and unauthenticated requests, including ownership-transfer attempts. Keep migration/admin credentials separate from normal user operations; privileged service keys cannot replace end-user authorization. Review views, functions, private storage buckets and signed result URLs with the same isolation tests. [Supabase row security](https://supabase.com/docs/guides/database/postgres/row-level-security).

Verify token signature, issuer, audience and expiration in protected APIs. Handle revocation where the operation requires it. Apply authorization per request and keep session-specific responses out of shared caches. The current client header and CORS checks do not authenticate users; the anonymous gateway needs an explicit abuse/quota policy before public growth. [Supabase authentication](https://supabase.com/docs/guides/auth/server-side/advanced-guide).

Use the managed connection pooler where appropriate for concurrent backend connections. Apply indexed queries and slow-query review before increasing compute. Configure database backups, recovery objectives and a restore drill for newly created production data; the earlier request to discard the old laptop installation does not define future user-data retention. Storage objects have their own backup needs. [Connections](https://supabase.com/docs/guides/database/connecting-to-postgres), [backups](https://supabase.com/docs/guides/platform/backups).

## Capacity and failure handling

Measured Samsung Direct-mode baseline: one generation slot, about 3.7 decoded tokens/second, five warm samples, approximately 4.2 seconds to first answer, and a 67C measured peak. This small local test does not establish a user-count capacity or reliable p95. Reasoned-mode deadline behavior remains unresolved. Docker packages workloads; it does not add CPU or make multiple model replicas fit in 7.5 GiB RAM.

Use the Samsung for development and bounded early testing. Before a public user launch, agree on a latency target, failure budget and expected simultaneous requests. Test long inputs, disconnects, queue saturation and dependency failures. Move text inference to stronger compute when measured queue/response times breach the target; retain the Samsung as the remotely managed development server. A future GPU text backend can evaluate vLLM's serving/batching support against the chosen model; it is not an image-model compatibility promise. [vLLM](https://github.com/vllm-project/vllm).

Keep image jobs asynchronous, idempotent and bounded. Begin with durable PostgreSQL job metadata and a controlled worker; add a dedicated queue when retries, scheduled jobs and worker count justify it. BullMQ is a Redis-backed Node queue candidate at that point. Do not add Redis solely because a queue library exists. [BullMQ](https://docs.bullmq.io/).

The selected Qwen image candidate belongs on GPU infrastructure. ComfyUI-GGUF is the intended loader candidate; pin and review custom nodes. Choose GPU capacity through actual workflow measurements and enforce authenticated, allowlisted job submission with cancellation and short-lived output access. [Model roadmap](ROADMAP.md), [ComfyUI-GGUF](https://github.com/leejet/ComfyUI-GGUF).

Keep frontends and gateway replicas stateless apart from in-flight requests. Shared quotas, durable job state and account data belong in managed infrastructure. Adding another gateway requires shared admission control; the current in-process single-model queue does not coordinate replicas. Define cold-start/readiness, provider timeouts and safe retries before scaling workers. Use OpenTofu when cloud resources need reproducible reviewable configuration. [OpenTofu](https://opentofu.org/docs/intro/).

## Incremental release order

1. Security/CI foundation and reviewed delivery policy.
2. Validate Docker CPU inference on the Samsung, then review container migration and digest-based delivery.
3. First managed database migration, Auth boundary and RLS tests; then account UX.
4. External health monitoring, browser tests, load targets and failure drills before real-user launch.
5. Separate GPU image-worker integration after workflow/license validation.
6. Cue integration after its credential, IPC and capture-permission review.

GitHub currently refuses enforced branch protection for this private repository on the account's plan. Follow PR/CI review manually until a supported plan is chosen. Supabase production security settings, authenticated abuse controls and external monitoring are release work still to implement. [Delivery status](DELIVERY.md), [Supabase production checklist](https://supabase.com/docs/guides/deployment/going-into-prod).
