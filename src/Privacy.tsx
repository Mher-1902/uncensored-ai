import {PRIVACY_PATH,COOKIES_PATH} from './legal-paths';
export {PRIVACY_PATH} from './legal-paths';
export const PRIVACY_VERSION='2026-10-21';

export function PrivacyContent(){
  return <div className="privacy-content">
    <p className="privacy-version">Updated October 21, 2026. Version {PRIVACY_VERSION}.</p>
    <p>Offscript is operated by Mher Sukiasyan, Armenia. For account or privacy requests, contact <a href="mailto:sukiasyanmher7@gmail.com">sukiasyanmher7@gmail.com</a>.</p>
    <p>This notice covers the Offscript website, accounts and temporary conversations. It explains how we handle information; it is not a release of responsibility for how the service operates.</p>
    <h2>Your account and sign-in</h2>
    <p>We use Supabase to manage accounts. Your chosen sign-in provider shares your identity, email address and permitted profile information. We use this to create or authenticate your account and operate the service. Offscript does not receive your Google or GitHub password. Google sign-in is offered only when configured.</p>
    <p>After you dismiss the informational welcome, we save its display version with your account so it does not repeat at each sign-in, including on another device. This preference does not record agreement to Terms, consent to tracking or permission to charge you. If it cannot be saved, the welcome may appear again.</p>
    <h2>Your conversations</h2>
    <p>Drafts and conversations stay in the current page’s memory. Messages pass through our website API to the model server to generate a reply. Offscript does not save a chat history, put messages into browser storage or its account database, or use conversations to build a model-training dataset. Request state is cleared after processing; canceling a reply initiates cleanup.</p>
    <p>Clear chat, signing out, reloading or leaving the page clears the conversation. Copying text, screenshots, browser extensions and your device can create copies outside this design. Temporary chats are not a guarantee of anonymity or zero infrastructure-provider logs. Do not submit passwords, private keys or information you are not entitled to share.</p>
    <h2>Browser storage</h2>
    <p>This tab’s session storage holds the sign-in session and the verifier needed to complete sign-in. Separately, after you press “Got it,” local storage remembers dismissal of the storage notice on this browser for up to 180 days. These entries do not save chats. Browsers may restore sessions, so sign out when using a shared device. See <a href={COOKIES_PATH} target="_blank" rel="noopener noreferrer">Cookies &amp; browser storage</a> for the entries, purposes and duration.</p>
    <h2>Purpose, retention and your choices</h2>
    <p>We process account and message information to provide the service you request. Where applicable, the legal bases are performing that service, legitimate interests in proportionate security and operation, and legal obligations. Reading this notice does not consent to unrelated processing.</p>
    <p>If you contact us, we receive your email address and the information you send, and use it to respond to the request.</p>
    <p>Our service providers may process technical records, such as IP addresses and request times, and may process information outside your country. We remain responsible for Offscript’s use of information. Provider terms and privacy notices describe how they handle their own records: <a href="https://vercel.com/legal/privacy-policy" target="_blank" rel="noopener noreferrer">Vercel</a>, <a href="https://supabase.com/privacy" target="_blank" rel="noopener noreferrer">Supabase</a>, <a href="https://tailscale.com/privacy-policy" target="_blank" rel="noopener noreferrer">Tailscale</a> and your chosen sign-in provider (<a href="https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement" target="_blank" rel="noopener noreferrer">GitHub</a> or <a href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer">Google</a>, when available).</p>
    <p>Account information, including the welcome-display preference, is kept while the account is in use, until a verified deletion request, subject to applicable legal or security requirements. Support messages are kept as needed to handle the request and associated issues. Provider security records and backups can follow different retention schedules. There is no saved chat archive for us to retrieve or restore.</p>
    <p>You can request access, correction or deletion of your account information using the contact above. We verify account ownership before taking action. Depending on applicable law, you may also have rights to restriction, objection, portability, withdrawal of consent where consent is used, and complaint to a data-protection authority. Do not email a password, verification code or unnecessary sensitive information.</p>
    <h2>Protecting information</h2>
    <p>The website uses HTTPS. Sign-in is checked on the server before chat requests are accepted, and backend credentials stay outside the browser. These controls do not guarantee that an incident cannot happen. Do not put passwords or private keys into a conversation.</p>
    <h2>Email and marketing</h2>
    <p>Promotional email and an automatic welcome-email sender are not enabled in this release. Signing in does not subscribe you to marketing. Any future marketing subscription will need a separate choice. An account does not authorize a future subscription charge. We do not sell conversation content or use advertising trackers in this release.</p>
    <h2>Age and guardian requirements</h2>
    <p>You must meet your sign-in provider’s requirements and applicable minimum-age and guardian rules. A verified guardian-consent flow is not available in this release. If guardian permission or consent is required for your use, contact us before creating an account. A privacy notice does not replace those requirements.</p>
    <h2>Changes and account controls</h2>
    <p>We will update this notice for material processing changes, including new model providers or account and subscription features. A privacy notice provides information about processing; it does not authorize a future charge or subscribe you to marketing.</p>
  </div>;
}

export function PrivacyPage(){
  return <html lang="en"><head><meta charSet="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><meta name="robots" content="noindex,follow"/><meta name="description" content="How Offscript handles sign-in, accounts and temporary conversations, and how to contact us about your information."/><meta name="theme-color" content="#111315"/><title>Privacy Policy | Offscript</title><link rel="canonical" href={`__SITE_ORIGIN__${PRIVACY_PATH}`}/><link rel="icon" href="/favicon.svg"/><link rel="stylesheet" href="/privacy.css"/></head><body><header><a className="brand" href="/">offscript<span>_</span></a><a href="/">Back to Offscript</a></header><main><h1>Privacy Policy</h1><PrivacyContent/></main></body></html>;
}
