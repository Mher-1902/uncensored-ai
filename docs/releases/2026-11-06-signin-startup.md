# Recover phone sign-in startup

A phone screenshot reported an unavailable sign-in before the GitHub button was pressed. The old hook published its client before getSession completed, then left it in place after initialization rejected. The pinned SDK retains that rejected initialization promise, so another call to the same client could not recover.

Use the SDK’s public AuthClient with explicit initialization and bounded, disposable startup attempts. Publish provider controls only after the session check completes. Preserve the saved envelope; retiring an attempt fences late writes. Retry on a return/reconnect after failure, or through Try again without page reload. Retain the shared lock requirement for durable sessions, and the isolated tab fallback when a browser exposes but denies that API. Explicit sign-out, inactivity expiry, provider PKCE and temporary chats keep their existing rules.

Samsung: 15 focused real-SDK tests and all 212 Node tests passed; the Python suite, both builds and both SEO checks passed. Peak 67°C, offline 0.25 CPU / 1536 MiB / no swap. Physical phone verification is separate from these fixtures.

Monitoring commissioning also verified actual cgroup CPU/RAM/swap/process values after reapplying complete Docker resource budgets. The monitoring user unit now repeats that enforcement and verifies the kernel after startup. This affects only the four monitoring containers. No serving model, production app/container restart, inference setting, paid resource or account schema change is included.
