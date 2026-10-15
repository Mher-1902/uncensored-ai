# Public registration and temporary chats

The owner selected public registration on October 14, 2026 and Google plus GitHub sign-in for the first beta on October 15. Email methods remain disabled until a sender is configured. The website implements Supabase sign-in, signup, password reset, recovery and local sign-out. Configured Google/GitHub buttons also register new users through the provider when project signup is enabled. Provider setup and a working hosted callback are still required; this source change does not enable hosted registration by itself.

The Supabase SDK is pinned in the lockfile. It uses PKCE and tab-scoped sessionStorage for the sign-in session and callback verifier. Chat messages remain in React/page memory, never in this store or the database. Reloading/leaving clears chats; sign-out or session loss also cancels inference and clears the conversation. An OAuth round trip leaves the page and consequently clears any draft/chat. Account data is managed by Supabase and the chosen identity provider; temporary conversations do not imply anonymous accounts or zero provider logs.

The client reads runtime `/config.json`, loads the SDK after configuration and forwards its current user access token only to the same-origin `/api/chat`. The existing gateway independently verifies that token before replacing it with the separate Samsung service credential. The website never receives that service credential or a Supabase secret/service-role key.

## Runtime configuration

| Variable | Meaning |
| --- | --- |
| `SUPABASE_URL` | Exact managed HTTPS project origin, shared with the gateway verifier |
| `SUPABASE_PUBLISHABLE_KEY` | Browser-safe `sb_publishable_…` key; privileged/legacy JWT keys are rejected by public configuration |
| `SUPABASE_AUTH_PROVIDERS` | Comma-separated enabled methods: `google`, `github`; advertise only providers actually configured in Supabase |
| `SUPABASE_EMAIL_ENABLED` | Set exactly `true` only after email signup, sender, confirmation and reset delivery are configured and checked; otherwise email forms stay hidden |

The CSP permits the selected project `https://pgyfliwdlonitlhzmmsj.supabase.co` for Auth requests. A project change must also update the two hosting header definitions. The public runtime config remains no-store. Absent credentials/methods display setup-unavailable text and authenticated chat stays unsent. Private Samsung development can retain its existing non-account configuration.

## Provider and email setup

Set the Supabase Site URL to the final HTTPS homepage and allow its exact homepage callback, plus explicitly approved preview/local URLs. Avoid a blanket wildcard across unrelated domains. The browser SDK handles the PKCE return at `/` with its stored verifier; return to the same browser tab. Password recovery links must also return to that configured homepage. Existing branding is a working name.

Google/GitHub require provider OAuth credentials configured directly in Supabase. Their provider callback for this project is `https://pgyfliwdlonitlhzmmsj.supabase.co/auth/v1/callback`. Provider secrets stay out of Git, the browser and public config. Google’s public app/consent setup is separate from its development testing mode. [GitHub setup](https://supabase.com/docs/guides/auth/social-login/auth-github), [Google setup](https://supabase.com/docs/guides/auth/social-login/auth-google).

The owner currently has no email domain. Supabase’s default sender restricts recipients to project-team addresses and is unsuitable for public registration. Google/GitHub can be prepared first; leave email methods off until a domain/sender is configured. A service such as Resend can provide confirmation/reset delivery through custom SMTP within its free allowance. Do not disable confirmation to work around missing delivery. No SMTP account, OAuth credential, paid service or email send is created by this change. [SMTP requirements](https://supabase.com/docs/guides/auth/auth-smtp).

Before opening registration, configure the project’s signup policy, password policy, redirect list and Auth rate limits. Keep the Samsung connection private/credential-protected until its approved bridge is configured. User quotas and operational capacity remain release work, separate from this account interface.

No application tables, profile persistence or chat archive are added here. New user/tenant tables must receive reviewed default-deny RLS and isolation checks before they become accessible. Supabase’s managed auth schema does not satisfy an application-table RLS requirement by itself.

## Validation and release status

Run TypeScript, build/SEO and application tests on the Samsung. Functional tests cover public configuration and same-origin token forwarding with dummy data; they do not contact Supabase, send emails or complete OAuth. Hosted signup, confirmation/recovery, redirect return, logout and one authenticated chat must still be checked with the owner before a usable launch. Direct mode is the initial default because Reasoned-mode completion on this CPU has not been established. The deeper security audit remains paused at the owner’s request.
