# Cookie and browser-storage notice

Owner requested a formal researched notice on October 20, 2026. This is a current-storage implementation and disclosure, not a claim that every legal launch requirement is completed.

## Inventory and implementation

- `src/account.tsx` configures Supabase PKCE authentication using `window.sessionStorage`, without a custom localStorage fallback. It stores the sign-in session and sign-in verifier, not chats. Provider-domain storage is separate.
- Application source has no analytics/advertising SDK, pixel, fingerprinting implementation, `document.cookie` writer or application `Set-Cookie` response. Vercel's project dashboard showed Analytics and Speed Insights not enabled during the October 20 release verification. This does not guarantee that hosting/security providers never set their own functional cookies.
- `src/storage-notice.ts` stores one public, non-identifying notice-dismissal value in tab session storage, only after Got it. It never enumerates or clears storage, overwrites authentication entries, writes chat content, or sends a consent/analytics event. Blocked storage degrades to page-local dismissal.
- The first-visit notice is an in-flow, nonmodal region. It does not cover the composer, stop chat, or claim that continued browsing grants consent. The Cookies footer control reopens details at any time. `/cookies.html` is generated from the same content and works without JavaScript or sign-in.
- There are no fake optional-cookie toggles or Accept all button because optional tracking is not enabled. Got it acknowledges a notice; it does not consent to tracking, accept Terms, opt into marketing, or authorize payment. The existing session-only auth contract and no-chat-storage design remain.
- A new tab or cleared storage can show the notice again. Browser restore can retain session storage; the public notice explains this without promising an exact deletion time.

## Primary guidance checked October 20

- [Latvia DVI: common cookie-banner mistakes](https://www.dvi.gov.lv/lv/jaunums/dviskaidro-kadas-kludas-visbiezak-tiek-pielautas-sikdatnu-baneros) recommends a short explanation and an acknowledgement-style button when only functional storage is used. If optional cookies are used, the choices must be real, neutral, understandable and reversible. A detailed-notice link should be available.
- [EU Your Europe: online privacy](https://europa.eu/youreurope/business/growing/digitalising/online-privacy/index_en.htm) distinguishes requested-service authentication/communication storage from purposes requiring prior specific consent. When consent is required, withdrawal must be as easy as giving it. These principles do not authorize adding trackers merely because a notice exists.
- [ICO: storage and access technologies](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guidance-on-the-use-of-storage-and-access-technologies/what-are-storage-and-access-technologies/) covers browser storage as well as cookies. It is UK guidance, useful for the technical scope rather than a substitute for EU/national review.

Before any future optional tracking: inventory each purpose/vendor/lifetime, review the applicable rules, block it until the required choice, provide equally accessible rejection and withdrawal, and test the network/storage behavior. Do not silently turn this essential-only notice into marketing consent. No optional tracking is activated by this release.
