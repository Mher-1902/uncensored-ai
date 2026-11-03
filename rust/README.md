# Offscript Rust backend candidate

Status: implementation in progress; not selected by the normal deployment.
The working production Node/Python path remains available for rollback.

The Rust crate contains the private Samsung HTTP gateway, service-credential
checks, validation, bounded scheduler, receipt/cancellation lifecycle, actual
input tokenizer, generation/continuation/SSE adapter and model supervisor.
Vercel still verifies account sessions; Postgres retains account metadata and
stores no conversation text. The public API and protocol5 remain compatible.

The selected native model still performs prediction, chat-template rendering,
reasoning parsing and output detokenization. Rust does not wrap C++ prompt
tokenization: the candidate's private input hook consumes Rust-produced IDs.
Unknown capability or tokenizer mismatch fails readiness rather than silently
using the old tokenizer. Replacing this backend does not establish faster model
decoding or large-user capacity.

## Tokenizer artifact

`scripts/export-rust-tokenizer.py` is a build-time metadata exporter. It verifies
the exact selected GGUF and preserves its248320 token IDs,247587 merges and
Qwen3.5 split/special rules. It emits `tokenizer.json` and a checksum/model-bound
`manifest.json` into a new `.data/tokenizer` directory. Do not commit model
weights or generated vocabulary files. The runtime uses the pinned Rust
`tokenizers` implementation with default features disabled; `onig` and the
optional C++ `esaxx_fast` feature must be absent. BPE prompt caches are disabled.

## Private validation and rollout

Use the Samsung's rootless Docker for manual builds/tests. The pinned compiler
image is Rust1.90.0 and code targets Ivy Bridge rather than the build machine.
Run locked/offline checks after a separate dependency fetch. Keep the existing
CPU/memory/no-swap limits,75°C experiment guard, AC check and priority for live
traffic. No Mac serving or inference and no paid resource is part of this work.

Before selecting `compose.yaml` plus `compose.rust.yaml`, require Rust contract
tests; exact multilingual/code/special/continuation token parity; native-hook
negative tests; signed-in protocol5/Stop/cleanup checks; measured cold/warm
memory within the existing256MiB gateway cap and2500MiB model cap; matched-output
timings; and an idle cutover/rollback proof. No prompt or token stream should be
written to logs or durable account records. The override is explicit and does
not change the production compose command by itself.

Candidate executables: `offscript-backend gateway`, `supervise`, `check-model`,
`check-gateway`, and private synthetic-fixture `tokenize` (JSON stdin/stdout).
The gateway requires the existing service credential via the environment;
never print it, put it in browser bundles, or paste it into source or chat.

The 31October owner addition—remember sign-in for30days of browser inactivity—is
recorded in `docs/PRODUCT-WORKLIST.md` and implemented independently of the Rust
runtime. Authentication persistence never authorizes saved chats or IP trust.
