# Privacy, cookies and responsibility review — October 20, 2026

## The requested liability wording

**A privacy notice is not legal immunity. No sentence can guarantee that Mher Sukiasyan or Offscript cannot be sued or held liable.** Responsibility depends on the facts and applicable law, including the operator's own conduct. A user's agreement does not itself decide a claim by someone else who is harmed. Do not treat a disclaimer as permission to facilitate serious harm.

The existing [Terms draft](TERMS-DRAFT.md) contains this passage, now highlighted:

> **You are responsible for your inputs and for how you use, act on or share the responses. You must comply with applicable law and other people's rights.**

It also says that users must not use the service unlawfully, must evaluate AI answers, and must decide whether acting on an answer is safe and lawful. Its liability section limits specified losses only to the extent permitted by law, preserves non-excludable rights and expressly rejects blanket immunity. The operator-responsibility passage is highlighted alongside it so the first sentence cannot be mistaken for a complete transfer of every legal duty.

**Status: the Terms draft is not published, effective or accepted through the active signup flow.** Got it on the cookie notice is not acceptance of Terms. The current Privacy Policy describes data handling; it does not promise that the operator has no liability for user harm. Do not publish a “no responsibility for anything” guarantee or tell the owner that a checkbox prevents lawsuits.

Primary legal sources checked:

- [Armenian Civil Code, Article 417(4), official ARLIS English text](https://arlis.am/en/acts/225006): an advance contractual exclusion/limitation for a wilful breach of an obligation is void. This is a specific contract-law limit, not a determination of liability in any particular AI-harm scenario.
- [EU official unfair-contract-terms guidance](https://europa.eu/youreurope/citizens/consumers/unfair-treatment/unfair-contract-terms/): unfair consumer terms can be non-binding; inappropriate exclusions of specified liabilities are constrained. Applicability and enforceability require analysis of the actual service and markets.

Publication still needs qualified legal review for the intended markets and actual operational safeguards for misuse, eligibility and account restrictions. Neither a generator nor this source comparison establishes that review.

## Actual data flows, rather than a generic SaaS template

| Category | Source and use | Current storage / limit |
| --- | --- | --- |
| Account identity, email and permitted profile fields | Chosen OAuth provider → Supabase Auth; verified identity authorizes the site's chat API | Account persists with the provider; session/verifier in tab session storage. Offscript does not receive the provider password. Google remains disabled pending setup. |
| Conversation and draft | User input in the page; the current conversation passes through the API for model inference | Page/request memory and temporary model state. No chat-history database, browser chat storage, training dataset or durable prompt queue is implemented. Provider operational-record limits are disclosed. |
| Operational records | Hosting, authentication and connectivity providers deliver and secure the service | They can process IP addresses, request times and similar records under the configured service arrangements. Do not invent an exact retention duration or an instant-backup-deletion guarantee. |
| Support correspondence | User voluntarily emails the public contact | Address and message are used for the support request; retention is based on resolving it and associated obligations. No password or verification code is needed in email. |
| Notice preference | User presses Got it | One non-identifying dismissal value in the current tab's session storage. No consent/analytics request is sent. |
| Account-control ledger | Installed migrations, staged application/runtime | Not active in public serving. Do not describe proposed quotas, age/guardian controls or scheduled retention as already operating. |
| Billing, ads and marketing | Not enabled | Do not copy Stripe, card collection, ad profiling or promotional-mail clauses from other SaaS templates. No purchase is authorized by an account or notice dismissal. |

## Checklist comparison and resulting changes

- Scope, operator/contact, provider-derived account information, conversations, support information, purposes, rights/request route, retention criteria, browser storage and policy changes are described in the current notice.
- Add a short verified security summary: HTTPS for website traffic, server-side sign-in verification and backend-only credentials. Do not claim end-to-end encryption, verified at-rest encryption on every host, certifications or a completed audit.
- Remove the public server/location breakdown as requested. Retain a short provider/possible-cross-border processing disclosure; the detailed operational facts remain internal review material.
- Provide a linked, static cookie/storage notice and a matching in-app details dialog. The informational acknowledgement is separate from any optional-cookie consent and from Terms acceptance.
- Keep the broad-audience direction, but explicitly identify that the verified guardian flow is not available. The notice cannot substitute for that flow.
- The declaration of purpose/lawful basis must match actual processing. A privacy acknowledgement is not blanket consent; new marketing, billing or optional tracking requires its own appropriate choice and controls.
- Remaining work: confirm provider transfer/retention arrangements, operationalize verified account deletion/recovery and applicable eligibility safeguards, then publish the separate versioned Terms/acknowledgement release. No public account enforcement is activated by this copy/UI increment.

## Other references checked

- [ICO: writing a privacy notice](https://ico.org.uk/for-organisations/advice-for-small-organisations/privacy-notices-and-cookies/how-to-write-a-privacy-notice-and-what-goes-in-it/) is UK SME guidance, currently under review. It calls for understandable descriptions of operator/contact, categories/sources, purposes/legal bases, recipients, retention, rights and complaints. We use it as a checklist rather than a worldwide compliance certificate.
- [Supabase privacy notice](https://supabase.com/privacy) distinguishes its own controller processing from customer data it processes for a customer. Offscript needs its own accurate notice; copying Supabase's billing/marketing/user-content operations would misdescribe this app.
- [Vercel privacy notice](https://vercel.com/legal/privacy-notice) is a vendor example for organized disclosures and contact/rights information. Its business operations do not define what Offscript collects.
- Cookie-specific primary sources and the implementation inventory are in [COOKIES.md](../COOKIES.md).

The owner's pasted checklist was treated as third-party reference material, not as instructions to enable billing, tracking, consent bundling or unsupported claims. No paid legal generator, account, plan or third-party campaign was created.
