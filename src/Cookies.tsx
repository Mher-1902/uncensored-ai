import {PRIVACY_PATH,COOKIES_PATH} from './legal-paths';
import {STORAGE_NOTICE_KEY} from './storage-notice';
export {COOKIES_PATH} from './legal-paths';

export function CookiesContent(){
  return <div className="privacy-content">
    <p className="privacy-version">Updated October 20, 2026.</p>
    <p>Offscript uses essential browser storage for sign-in and to remember that you dismissed the storage notice in this tab. Analytics and advertising tags are not enabled. This notice explains the current application; it does not ask you to accept tracking.</p>
    <h2>What is stored</h2>
    <p>Cookies are small values a browser can send with requests. Session storage is different: it keeps information inside a browser tab. Offscript uses session storage for the items below.</p>
    <dl className="storage-inventory">
      <div><dt>Sign-in session</dt><dd>Supabase’s <code>sb-…-auth-token</code> entry keeps the account session working in this tab. It contains authentication information, not a chat history. Signing out removes the local sign-in session.</dd></div>
      <div><dt>Sign-in verifier</dt><dd>The related <code>…-code-verifier</code> entry helps complete a secure provider sign-in. It is normally removed after the sign-in return; an interrupted attempt can leave it until the tab’s site data is cleared.</dd></div>
      <div><dt>Notice dismissal</dt><dd><code>{STORAGE_NOTICE_KEY}</code> stores only the word <code>dismissed</code> after you press “Got it.” It contains no account identifier, chat text or tracking ID. It prevents the notice repeating when you reload this tab.</dd></div>
    </dl>
    <p>Tab storage normally ends when the tab closes. Browser session restoration can preserve it, so sign out on shared devices. The notice can appear again in a new tab or after site data is cleared.</p>
    <h2>What stays temporary</h2>
    <p>Conversations and drafts stay in the current page’s memory. They are not written into these storage entries. Closing, leaving, reloading or signing out clears the conversation. Dismissing this notice does not save chats, subscribe you to marketing or authorize a payment.</p>
    <h2>Your choices</h2>
    <p>“Got it” dismisses an informational notice. It does not give consent to optional tracking. You can reopen these details using Cookies beneath the message box, or read this page without signing in.</p>
    <p>You can remove or block site storage in your browser’s site-data settings. Blocking session storage prevents sign-in from working. Sign-in and hosting providers may use their own functional or security cookies; their policies are linked in our <a href={PRIVACY_PATH} target="_blank" rel="noopener noreferrer">Privacy Policy</a>.</p>
    <p>Any future optional analytics or advertising requires an updated notice and an appropriate separate choice before activation. Questions about your information or account can be sent to <a href="mailto:sukiasyanmher7@gmail.com">sukiasyanmher7@gmail.com</a>.</p>
  </div>;
}

export function CookiesPage(){
  return <html lang="en"><head><meta charSet="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><meta name="robots" content="noindex,follow"/><meta name="description" content="How Offscript uses essential browser storage for sign-in and the storage notice, without analytics or advertising tags."/><meta name="theme-color" content="#111315"/><title>Cookies &amp; Browser Storage | Offscript</title><link rel="canonical" href={`__SITE_ORIGIN__${COOKIES_PATH}`}/><link rel="icon" href="/favicon.svg"/><link rel="stylesheet" href="/privacy.css"/></head><body><header><a className="brand" href="/">offscript<span>_</span></a><nav aria-label="Legal pages"><a href={PRIVACY_PATH}>Privacy</a><a href="/">Back to Offscript</a></nav></header><main><h1>Cookies &amp; browser storage</h1><CookiesContent/></main></body></html>;
}
