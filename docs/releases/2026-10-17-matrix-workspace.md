# Matrix workspace release — October 17, 2026

Live website: https://offscript-ai.vercel.app/

Source: `39646ec511e7c3097dfd5d3fdede6dec1552d62f`, branch `codex/matrix-workspace`, PR #17. Production deployment: `BiDfRL4LQKCatvTtfRaa24LdHmgf` in the existing Vercel project. The source was rebuilt with the existing **Production** settings; a Preview build with different environment variables was not simply promoted.

The release replaces the large anonymous figure and decorative scroll motion with a small Aralez mark, charcoal surfaces and green monospace responses. Fast is the default and Deep Think is explicit. Stop/Copy/Clear remain, with an accessible mobile Clear control. Per-visitor 30-second readiness polling is removed.

Evidence: both build paths and SEO checks, 40 Node tests and 4 Python tests passed on the Samsung. The Docker CI rerun passed after a transient Fedora registry lookup failure. Desktop and 390px mobile fixture checks exercised streaming, both modes, Copy, Stop and Clear. A fresh browser session completed existing GitHub sign-in on the live domain, reported the Samsung Online, and returned `391` for `17 × 23` through the real inference path. That is one smoke test, not a speed, sustained-load or model-quality benchmark.

The Samsung's running model and containers were not replaced. The new account database/schema, API enforcement, credentials and legal publication remain inactive. PR #19 contains tested, default-off account admission work; it is not part of this deployed source. No paid service was created. Full audit/Daybreak and external Grafana remain deferred.

Rollback: the preceding Production source was `6629206c414e61b334f3993334c2a292971472ef` (PR #13). Production deployment `DCh2FFWEuyBZhQ3iqqRQ5mhvCYNo` remains available in Vercel. Use its verified deployment/Production environment for rollback rather than rebuilding an unrelated branch.

The PR stack is still unmerged. Do not infer that this source is already on main, or deploy intermediate historical commits automatically while reconciling the stack.
