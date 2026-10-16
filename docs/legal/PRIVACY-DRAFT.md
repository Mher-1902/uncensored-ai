# Offscript Privacy Policy

**Draft for review. Not published or effective. Version: 2026-10-17-draft.**

Operator and account/data contact: Mher Sukiasyan, Armenia, [sukiasyanmher7@gmail.com](mailto:sukiasyanmher7@gmail.com).

## The essentials

Your account persists; your chat does not have a saved history. Messages are processed to generate answers, so temporary chats are not a guarantee of anonymity or of no processing by infrastructure providers. We do not use conversations to train models, and the application does not store prompts or replies in its database, usage metrics or application logs.

## What is processed and why

- **Account information:** Supabase manages your account. With GitHub sign-in, it receives the information allowed by that sign-in, such as your provider identity, profile details and email address. We use the account identifier to authenticate you and control access. The app does not receive your GitHub password.
- **Messages and responses:** the current conversation is sent through the website API to the connected inference server. The server processes it in memory to generate a streamed response and clears request state after processing. We do not build a chat archive or durable prompt queue.
- **Pilot account controls, when activated:** account plan, access/eligibility status, policy-version acknowledgement, request counts, token totals and the last active day support admission, quotas and evaluation of the pilot. These records do not contain message text. We do not collect a birth date or identity document in the proposed schema.
- **Operational traffic:** Vercel hosts the website/API; Supabase provides account/database infrastructure; Tailscale transports the protected connection to the Samsung inference server. Those providers process network or security information needed to deliver their services. Such information may include IP addresses, request times and device/browser information, subject to their configurations and policies.
- **Support:** if you email us, we receive your address and the information you include. Do not include passwords, sign-in codes or unnecessary sensitive information.

We use necessary account and message processing to provide the service you request. Where applicable, we rely on legitimate interests for proportionate security and service operation, and on legal obligations where processing is required by law. Acknowledging this notice is not blanket consent to unrelated processing. Any separate activity requiring consent must offer an appropriate choice.

## Browser storage and temporary chats

Conversations and drafts stay in the current page's memory. Clear chat, sign-out, reloading or leaving that page clears the conversation. Copying an answer creates a copy under your control outside this design. Browser extensions, screen capture, your device, or copies you share are not controlled by Offscript.

The current sign-in implementation uses this tab's session storage for the Supabase session and its sign-in flow. It does not put prompts or replies into session storage or local storage. A browser may restore tabs or sessions; use Sign out when you finish on a shared device. This draft does not claim that the app already uses an HttpOnly cookie session.

## Retention and deletion

Account information is retained while you use the account, subject to deletion requests and any required legal retention. There is no saved conversation history for us to retrieve or restore.

The proposed pilot-control retention is 24 hours for finished request metadata and 35 days for daily usage totals. Unresolved requests retain minimal metadata until the worker is reconciled so that capacity is not reused incorrectly. Policy acceptance receipts are retained with the account to record the applicable version. These retention periods require the cleanup task to be activated and verified before this policy takes effect for those controls.

You can request access to, correction of or deletion of your account information by emailing [sukiasyanmher7@gmail.com](mailto:sukiasyanmher7@gmail.com). We verify requests appropriately. Account deletion removes associated application records after active inference is stopped. Infrastructure backups and provider security records may expire on different schedules; deletion is not a promise that every provider backup disappears instantly. Any applicable legal exception will be explained.

## Sharing, location and security

The providers named above receive data needed to provide the service. OAuth sign-in also involves the chosen identity provider. We do not sell conversation content or provide a conversation-training dataset. Disclosures may also be required by law or needed to protect users and the service, subject to applicable obligations.

The operator is in Armenia. Provider processing can occur in other countries. Actual project regions, provider retention and applicable transfer safeguards must be confirmed before publication; this draft does not assert an unverified hosting region or transfer mechanism.

We use HTTPS, server-side session verification, restricted backend credentials and input validation. The proposed account schema adds row-level security and server-controlled writes. No security measure guarantees that an incident cannot happen, and this notice does not represent a completed security audit.

## Your choices and rights

You can clear the chat, sign out, stop using the service, and contact us about your information. Depending on applicable law, you may have rights to access, correction, deletion, restriction, objection, portability, withdrawal of consent where consent is used, and complaint to a relevant supervisory authority. These rights may have legal conditions; we will explain our response and any applicable exception.

We will publish a new version for material changes to this notice and provide the required notice. We do not silently turn temporary chats into a saved history or training dataset through a notice update.

---

Publication blockers: approve the age/guardian eligibility policy, confirm provider regions/retention and applicable transfer disclosures, verify the deletion/contact process and cleanup schedule, and make all statements match activated features. This draft does not resolve children's privacy obligations. See [publication notes](PUBLICATION.md).
