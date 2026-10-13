# Vercel website and internal API bridge

The owner confirmed this deployment layout on October 13, 2026: services `app`, `api` and internal `gateway`, public website/API paths, and the API-to-gateway runtime binding. Development runs on the Samsung; Vercel hosts the built website and lightweight request handlers. Docker, the CPU model and thermal guards stay on the Samsung. Image generation stays on separate GPU infrastructure. Cloud deployment and upstream connection still need configuration and validation.

The existing `cloud/huggingface` directory is a Gradio/ZeroGPU candidate that loads CUDA weights at import time. It is not a Vercel Python API, and it is excluded from the service definitions. Its deployment/GPU validation remains separate work.

## Routing and binding

| Component | Role | Public access |
| --- | --- | --- |
| `app`, repository root | Prerendered Vite website | Catch-all rewrite routes public website requests here |
| `api`, `cloud/vercel-api` | Hono server functions for public configuration and model requests | `/config.json` and `/api/*`; only health/chat endpoints are implemented |
| `gateway`, `cloud/vercel-gateway` | Stateless authentication and streaming bridge | Internal only; no public rewrite |
| Samsung Docker gateway/model | Bounded inference, queue and thermal controls | Currently private; no new public tunnel is configured by this change |

The public API's **server functions** declare a binding to `gateway`, injected as `GATEWAY_URL`. Do not set that variable in a dashboard, `.env` file, build or browser. The static `app` has no binding: its browser code uses same-origin `/api`. Relative URL construction preserves a binding's base path. The gateway accepts exactly `/api/chat` and `/api/health`; model administration is never forwarded. Both Node services use Vercel's documented Hono adapter and the Services runtime label `node`. A static Vite service does not execute sibling API functions in this mode. [Hono adapter](https://vercel.com/docs/frameworks/backend/hono).

Vercel services preserve the original public request path. An app-wide rewrite selects the service, not an SPA index fallback: unknown pages retain a 404. Public headers enforce same-origin connections and no-store/noindex API responses. [Routing](https://vercel.com/docs/services/routing), [bindings](https://vercel.com/docs/services/bindings), [Node functions](https://vercel.com/docs/functions/runtimes/node-js).

## Environment and authentication

An earlier source config points at the erased server's public hostname. The more specific `/config.json` rewrite selects the API service, which publishes only same-origin `/api` and public model metadata. This works during `vercel dev` as well as deployments; no internal binding or credential appears in browser configuration. Vite uses its multi-page mode to preserve actual 404 responses instead of a catch-all HTML fallback.

| Variable | Where | Purpose |
| --- | --- | --- |
| `GATEWAY_URL` | Public API runtime; generated binding only | Private URL of this deployment's gateway |
| `SITE_ORIGIN` | App build | Final HTTPS homepage for canonical metadata; alternatively Vercel's production URL system variable |
| `SUPABASE_URL` | Gateway runtime | Exact managed project API origin for session issuer/JWKS validation |
| `SAMSUNG_API_ORIGIN` | Gateway runtime | Reachable, approved HTTPS origin of the protected Samsung gateway |
| `SAMSUNG_GATEWAY_TOKEN` | Gateway runtime secret | Separate random service credential, never a Supabase admin key or browser value |
| `GATEWAY_ACCESS_TOKEN` | Samsung runtime secret | The same service credential, required for chat and other API requests except readiness |

The owner's Supabase dashboard identifies project `pgyfliwdlonitlhzmmsj`. Confirm its role as the development project and inspect signing keys before configuring its API origin. No project secret or key is embedded in the source, no remote migration is applied, and no account UI is implemented here.

Chat requires a signed-in Supabase access token. The bridge verifies its signature against the fixed project's public JWKS, issuer, `authenticated` audience/role, UUID subject and expiry. Anonymous, privileged, expired, wrong-project and wrong-signature tokens are rejected. Asymmetric ES256/RS256 keys are supported; legacy shared-secret signing needs migration or a separately reviewed verification path. Normal sign-in UI/token forwarding and abuse quotas are the next account increment. This JWT boundary does not implement database RLS; RLS and isolation tests belong with the first schema migration. [Supabase JWT verification](https://supabase.com/docs/guides/auth/jwts).

The bridge replaces the user token with the Samsung service credential. Configure that credential on both ends **before** making any Samsung endpoint reachable to Vercel. Private Tailscale IPs cannot be used as Vercel's upstream without a separately configured network connection. The previous erased server's public Funnel hostname is not a current endpoint. Missing or invalid bridge configuration returns offline/503 and sends no prompt to a model.

Requests have a 64 KiB JSON limit. Outgoing paths and forwarded headers are fixed; cookies, browser origin and arbitrary proxy targets are not forwarded. Redirects are refused. Streams preserve cancellation across both hops, and upstream credentials/response cookies are not returned to the browser. The public API deadline is 280 seconds and bridge deadline 270 seconds, below each configured 300-second Vercel function limit. Those deadlines do not certify Reasoned-mode completion on the Samsung's CPU. [Function duration](https://vercel.com/docs/functions/configuring-functions/duration).

## Validation on the Samsung

In an isolated development checkout, using Node 24:

```sh
npm ci
npm ci --prefix cloud/vercel-api
npm ci --prefix cloud/vercel-gateway
npm run build
npm run check:seo
npm test
VERCEL_ENV=production SITE_ORIGIN=https://offscript.example.test npm run build:vercel
npm run check:seo
npm audit --audit-level=high
npm audit --prefix cloud/vercel-api --audit-level=high
npm audit --prefix cloud/vercel-gateway --audit-level=high
npm exec --yes --package=vercel@63.1.2 -- vercel dev -L
```

The real `vercel dev --local` check on the Samsung passed: all three services started, `/config.json` returned same-origin `/api`, the injected binding reached the offline internal gateway, a same-origin browser-style POST stayed offline, and unknown pages/model administration/private-service URLs returned 404. API responses had no-store/noindex headers. No Vercel login or production upstream was used. Static deployment headers still require a cloud preview check; the local Vite server does not reproduce all deployment headers. Unit tests additionally verify signed sessions, payload rejection, streaming, two-hop disconnect cleanup and redacted errors. Preview/local builds set noindex/disallow-all; production requires its canonical origin.

## Review and deployment

The owner confirmed `app`, `api` and `gateway`; public website routing through `app`; `/config.json` and `/api/*` through `api`; and the API-to-gateway binding. All 27 tests, production build/SEO checks and three dependency audits passed on the Samsung. Keep the draft PR under review while the independent security audit finishes. This change does not create a Vercel project, enable a Samsung tunnel, create secrets, provision paid services, or publish version 1.0.

Vercel Services is currently beta and each service is subject to function limits and billing. Evaluate the chosen plan before a commercial user launch. Hosted Supabase preview branching is separate from ordinary Git branches/PRs; this change does not require a plan upgrade. [Services](https://vercel.com/docs/services), [limits](https://vercel.com/docs/services/pricing).
