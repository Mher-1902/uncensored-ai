# Signup and welcome delivery

Owner requests, October 19, 2026: show privacy information at signup; replace the personal GitHub OAuth owner with a brand; add Google; welcome users inside the website and prepare email for later. Google setup was explicitly deferred after its Google Cloud two-step-verification requirement appeared. No paid resource or trial is authorized.

## Website increment

The sign-in/create-account dialog shows a concise privacy summary before the provider buttons, with the full current notice expandable in the same popup. `/privacy.html` is rendered from the same React content during both builds, works without JavaScript and is linked beneath the composer. It describes the currently deployed processing rather than claiming proposed quotas/retention are already active.

A neutral welcome appears after a real SIGNED_IN event, once per user per page session. Repeated SIGNED_IN events on refocus must not reopen a dismissed welcome. INITIAL_SESSION restoration alone does not show it. Signing out resets the page-local welcome state. It does not infer that every OAuth login created a new account, write profile metadata, store chats, or call an email sender. The CTA restores focus to the composer after the native dialog closes.

This is privacy disclosure and onboarding, not a durable acceptance or eligibility gate. `PILOT_ACCOUNT_CONTROL`, the unpublished Terms/privacy acceptance registry, NOLOGIN role, existing migrations and protocol-5 activation remain unchanged. The older draft documents concern the staged account controls and are still drafts. Guardian/age enforcement, provider-transfer/retention review, verified deletion/recovery, and scheduled metadata cleanup remain launch work; displaying a notice does not establish those controls.

## GitHub branding

The app is already named `Offscript_`; `Mher-1902` appears because that personal account owns OAuth app 3935352. Website CSS or an app description cannot remove GitHub's owner disclosure. No organizations were returned by the authenticated membership listing.

Prepare a GitHub **Free** organization under the brand, owned by the user. Stop for the human to complete CAPTCHA/device checks and any Terms acceptance. Do not create a paid plan, transfer repositories, change the user's personal login, revoke tokens, regenerate secrets, or transfer the OAuth app to an unrelated owner.

Once the organization exists, prepare transfer of only the existing OAuth app to that exact user-controlled organization. Obtain action-time confirmation before the security-sensitive ownership transfer and acceptance. Verify the existing callback and a normal sign-in afterward. Preserve all credentials and the existing repository's branches/PR pipeline.

[Official OAuth ownership transfer](https://docs.github.com/en/apps/oauth-apps/maintaining-oauth-apps/transferring-ownership-of-an-oauth-app).

## Google handoff (pending at owner's request)

Google Cloud blocked access until the owner's account enables two-step verification. No Google OAuth project/client/secret or billing was created. Keep Google hidden in public config until setup works.

When resumed, use a Google OAuth Web application under the existing brand:

- Name: `Offscript_`; audience: external, with public production access deliberately configured before calling signup public.
- Homepage / JavaScript origin: `https://offscript-ai.vercel.app/` / `https://offscript-ai.vercel.app`.
- Privacy: `https://offscript-ai.vercel.app/privacy.html`.
- Authorized redirect: `https://pgyfliwdlonitlhzmmsj.supabase.co/auth/v1/callback`.
- Only OpenID, email and profile access. No Gmail, Drive, contacts or other unrelated permissions.
- Human enters new Client ID/Secret directly into the existing Supabase Google provider and saves/enables it. Never put them in chat, Git or browser bundles.
- After a working redirect test, add `google` to the existing Production `SUPABASE_AUTH_PROVIDERS` value and redeploy. Do not set service bindings manually or broaden allowed return URLs.

Google branding/domain verification may be a separate provider requirement. Do not promise the Supabase project hostname can be hidden at zero cost or that a testing-only OAuth app already admits the public.

[Supabase Google setup](https://supabase.com/docs/guides/auth/social-login/auth-google), [Google brand verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification).

## Email (prepared, not activated)

The owner chose both in-app and email welcome, with email later. See [the copy and delivery gates](email/WELCOME-TEMPLATE.txt). There is still no controlled sender domain. Supabase's default team-only sender is not public transactional delivery. A template does not configure a sender or send anything.

Future activation needs a verified domain/sender, bounded free-tier delivery, a trusted first-signup event, server-side idempotency, retry/bounce handling, and approved test delivery. Account-service mail is separate from marketing consent. Do not send a welcome on every login or expose a browser-callable arbitrary-recipient mail endpoint.
