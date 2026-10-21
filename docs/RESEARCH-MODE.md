# Multi-source research requirement

Recorded October 21, 2026. The owner wants factual answers checked against multiple sources instead of trusting one model or one website. This is source verification, not a claim that the current model has a mixture-of-experts architecture.

## Product contract

- For a researched factual answer, seek at least two independent publishers. Syndicated copies, mirrors, several pages from one publisher and multiple model opinions are not independent confirmation.
- Prefer primary evidence: official documentation, original research, statistics and the responsible organization. Check publication dates and the date the claim concerns. Search snippets alone are not evidence for the final claim.
- Open and inspect the sources, compare the actual claims, disclose disagreements and insufficient evidence, and attach real source links close to the claims they support. Never fabricate a citation, consensus, quotation or confidence score.
- Do not force extra sources when only one authoritative source exists. State that limitation and distinguish inference from confirmed facts.
- Keep writing, transformations and ordinary coding tasks available without unnecessary web requests. Automatic factual routing versus an explicit Research mode is awaiting the owner's choice because retrieval adds latency and external data processing.

## Retrieval and privacy gates before activation

The deployed pilot currently has no live web-search/retrieval adapter. No Research answer or automatic cross-check is claimed by this document. The selected model and its ordinary Fast/Deep Think behavior are unchanged.

Before release, implement and verify a bounded search/retrieval adapter and source ledger. Use a minimal search query rather than the entire conversation; do not send account credentials, account identifiers, private chat history or unrelated personal details to search providers. Provide an accurate user-facing explanation of external search processing before that mode is used. Keep queries, source extracts and conversations in request memory rather than saving a chat archive.

Treat retrieved text as untrusted data, never as instructions to use credentials or tools. Enforce outbound destination/redirect/size/time limits and block private-network access. Validate citations against documents actually retrieved. Propagate Stop and deadlines through retrieval and generation, clear request state, and report retrieval failure truthfully without silently calling a normal model answer researched.

Choose free infrastructure within the owner's $0 constraint. Do not create paid search plans, trials, automatic overages or hosted GPUs. Public search services have rate limits and terms; an unmeasured free pilot does not establish capacity for 50,000 users. Benchmark retrieval latency, answer usefulness, failure recovery, source independence and privacy behavior before enabling the UI mode.

## Acceptance examples

1. A current technical question cites official documentation and an independently relevant primary source, with the version/date made clear.
2. Two copied news pages count as one origin, not consensus.
3. Conflicting figures remain visibly qualified rather than being averaged into an invented fact.
4. A malicious instruction inside a source cannot change the system's tool permissions or expose another chat.
5. A failed or unconfigured search returns a clear limitation; no fake citations or Research badge appears.
