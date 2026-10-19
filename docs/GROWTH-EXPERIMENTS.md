# Zero-budget growth experiments

Research and recommendations, October 19, 2026. These are proposals, not campaigns already run or evidence of traction. No posts, invitations, emails, analytics SDKs or advertising purchases were made.

## Decision

Win a small group of people who get useful answers repeatedly before trying to acquire 50,000 users. Current ~4-token/second CPU decoding and unproven concurrency make a large traffic spike a risk to retention. For illustration only, 500 output tokens at 4 tokens/second takes 125 seconds before adding prompt processing and queue time. A registration is not a concurrent model slot. Roll out cohorts within measured admission limits, then expand after benchmark/capacity gates pass.

Start with general problem solving and coding, the owner's chosen first-use cases. Lead with an honest demonstration of useful answers and temporary chats. Avoid claims of unlimited access, guaranteed speed, anonymity, superior model quality or a model that can never refuse. The existing slogan is positioning, not evidence for those promises.

## Experiments, in order

| Experiment | What we would implement | Benefit / tradeoff | Small validation |
| --- | --- | --- | --- |
| First useful answer | Two optional starter questions (one coding, one general), filled into the draft without auto-submitting. Existing privacy/welcome explains Fast, Deep Think and temporary chats. | Helps newcomers try a real task; extra UI must not obstruct users who already know what to ask. | In a small consenting pilot, ask whether the first answer helped and record first-text/full-answer latency without storing prompt/reply text. |
| Founder-led demonstrations | Short, honest screen recordings of a completed coding/general task; share lessons about building on a Samsung in relevant Armenian, Latvian and global developer communities. Prepare platform-specific copy and captions for owner review. | Authentic and free to produce; founder time is the cost. Do not use a speeded-up clip to imply real latency. | Compare useful-answer feedback from two audiences; expand the audience that returns, not simply the one that clicks. |
| Searchable guides | Three original pages on real use cases, with reproducible examples and truthful limits. Add canonical metadata and sitemap entries only for finished pages. | Compounds over time; slower than a launch spike. No mass-generated keyword pages or untested quality claims. | Check Search Console indexing/impressions after ownership setup, then first useful answers from those pages. |
| Community feedback launch | A working, capacity-limited demonstration and candid technical post, with the founder present to answer questions. Do not post yet while the public experience cannot absorb demand. | Can attract strong feedback; traffic can overwhelm this backend. A signup-only waitlist does not qualify as a Show HN. | Run a controlled pilot first, then choose one appropriate community rather than posting the same pitch everywhere. |
| Product Hunt | Prepare a real demo, screenshots, concise maker story and a release-day support plan. Pick a date only after OAuth, privacy/account controls and capacity checks pass. | Concentrated early-adopter feedback; creates a burst of demand. No paid hunters, purchased votes or votes tied to rewards. | Define success as completed useful sessions and opt-in feedback, not leaderboard rank. |
| User-controlled sharing | Offer explicit Copy/Download of an answer with optional brand attribution. Keep it client-side; never publish a private conversation automatically. | Shares value users choose to show; content can expose sensitive information, so users control selection and destination. No public chat archive. | Ask pilot users whether they would share an example; prototype only if they want it. |
| Referral loop, later | A branded invite link with a random code and server-verified redemption after a real new account activates. No contact upload. Only offer a bounded perk after quotas/anti-abuse and capacity work. | Incentivizes word of mouth; fake signups and unlimited compute rewards can sink a zero-budget service. | Test a small cohort with a fixed redemption cap. Reward actual useful activation rather than raw signups. |
| Opt-in product updates, later | Separate unchecked marketing preference, content-free consent record, unsubscribe and suppression. Send useful release notes only after the sender domain and delivery controls exist. | Can bring interested users back; requires consent/delivery operations. Signup/welcome must not automatically subscribe them. | A small voluntary list; review unsubscribes/complaints and returning useful sessions. No bought lists or unsolicited bulk mail. |

The activation experiment is this project's proposal. The channel ideas below are informed by primary-source examples; they do not predict Offscript's results.

## Primary-source lessons

- [Google's people-first content guidance](https://developers.google.com/search/docs/fundamentals/creating-helpful-content): build pages that solve a reader's task rather than pages made primarily to attract search traffic. Apply this to a few tested guides and avoid thin AI-generated content farms.
- [Show HN rules](https://news.ycombinator.com/showhn.html): submit something people can actually try, explain the personal technical work, and avoid asking friends for votes. Its preference for low-friction trials conflicts with our current mandatory sign-in; solve that honestly with a bounded demonstration before choosing this channel.
- [Product Hunt launch guide](https://help.producthunt.com/en/articles/17350772-launch-guide): prepare the demo and story before launch, participate and answer feedback, and don't buy or solicit votes. A launch is a conversation with early adopters, not proof of retention.
- [Dropbox's referral mechanism](https://help.dropbox.com/storage-space/earn-space-referring-friends): a concrete reward connected to successful referral actions is an example of a product-led loop. Our proposed adaptation must cap rewards; extra inference is not costless storage.

## Measurement without a chat archive

Proposed funnel: visit → provider redirect → verified sign-in → first answer starts → naturally completed answer → user reports usefulness → voluntary return. Separate queue rejection, first-text time and full-answer time. Define denominators before comparing cohorts.

Implementation later: minimal first-party metadata/aggregate counters with reviewed retention and access controls; never prompt/reply bodies, provider tokens, email addresses in analytics, or per-keystroke capture. Don't add advertising pixels or a third-party session recorder. Signup telemetry is not permission to send marketing.

First pilot: 20–30 consenting people over two weeks, staggered within measured server capacity. These are proposed experiment sizes, not proven capacity or growth forecasts. Stop acquisition if admission rejects become common, latency exceeds agreed targets, users cannot obtain useful complete answers, or safety/account controls fail. Fix the product before increasing traffic.

## Launch sequence

1. Ship the factual privacy disclosure and welcome. Keep Google pending until the owner completes its provider setup; move the OAuth app only after the exact branded organization is human-created and transfer is approved.
2. Measure a safe inference improvement; finish account admission, eligibility, recovery/deletion and policy/retention activation. Preserve thermal limits and no saved chats.
3. Validate realistic concurrency and a small real-user pilot; publish measured limits.
4. Try founder demonstrations and a few useful guides, then a controlled community launch.
5. Add sender/domain and optional updates when available; consider referrals only after capacity and abuse controls.
6. Build subscriptions only after useful repeat usage and a sustainable serving budget. Do not present 50,000 accounts as 50,000 simultaneous generations at zero provider cost.
