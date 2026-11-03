# Correctness-preserving cache contract

Status: design and private validation plan, November 2, 2026. **Cross-request caching is not implemented or enabled.** The Rust candidate and the production protocol5 behavior still erase the native slot before completing an answer. This document does not authorize a production configuration change.

## Decision

Reuse exact computation, and generate each answer afresh. The first candidate is one short-lived, owner-bound conversation prefix in the Samsung's existing RAM allocation. A miss performs the ordinary full prompt processing; it never substitutes an old answer, silently removes history, reduces context, changes precision or chooses a weaker model.

The potential benefit is a shorter repeated-prefill/first-token wait. It does not establish faster per-token generation, better model intelligence or any concurrency capacity. A short first question or an ownership change may receive no benefit.

Keep these separate:

| Cache | Scope and decision |
| --- | --- |
| Loaded model weights and tokenizer vocabulary | Immutable, checksum-bound process data; already loaded once. Ordinary OS file caching is not a conversation cache. |
| Continuation within one answer | Already present: the Rust engine checks that the new rendered prompt is exactly the old prompt plus emitted text before requesting native prefix reuse. Cleanup still follows the whole logical answer. |
| Private prompt tokenization results | The Rust BPE cache is deliberately disabled. Do not add an unowned global text/token cache. |
| Prefix across separate answers | New protocol and lifecycle work described below; disabled pending evidence. |
| Public reference embeddings | A future retrieval feature may persist vectors for approved public documents, keyed by complete encoder/corpus versions. Never include personal chats or user-query history in that artifact. |
| Complete or semantically similar answers | Excluded. Similar wording is not proof that two requests mean the same thing or have the same current facts. |

## Why a native cache switch is insufficient

These findings refer to native revision `0504396140d1c882f5f6ee34466a42db7ae90114`, not an assumed future version:

- `--cache-ram 0` disables the global prompt LRU. Per-slot context checkpoints have separate controls. Defaults are 32 checkpoints and an 8192-token minimum spacing. [Pinned parameters](https://github.com/ggml-org/llama.cpp/blob/0504396140d1c882f5f6ee34466a42db7ae90114/common/common.h#L632-L638), [option definitions](https://github.com/ggml-org/llama.cpp/blob/0504396140d1c882f5f6ee34466a42db7ae90114/common/arg.cpp#L1592-L1633).
- Hybrid memory combines attention and recurrent state. Removal first asks the recurrent side, which can reject a partial rollback. Its rollback snapshots are bounded by `n_rs_seq`. [Hybrid memory](https://github.com/ggml-org/llama.cpp/blob/0504396140d1c882f5f6ee34466a42db7ae90114/src/llama-memory-hybrid.cpp#L161-L168), [recurrent rollback](https://github.com/ggml-org/llama.cpp/blob/0504396140d1c882f5f6ee34466a42db7ae90114/src/llama-memory-recurrent.cpp#L168-L215).
- The server can restore an eligible checkpoint or fall back to full prefill. It initializes request sampling and rebuilds prompt penalty history. Our adapter must preserve both behaviors. [Pinned server implementation](https://github.com/ggml-org/llama.cpp/blob/0504396140d1c882f5f6ee34466a42db7ae90114/tools/server/server-context.cpp#L3178-L3250).

In particular, matching text or even a common token prefix does not prove that the corresponding hybrid state can be reused. Count the tokens the native engine actually reuses. A fallback is correct and must not be reported as a cache hit.

## Trusted ownership and request contract

Protocol5 carries a service credential and request receipts, not an authenticated account/conversation identity. Keep it unchanged. Retention needs a distinct capability and a versioned protocol understood by both Vercel and Rust; unsupported or missing context uses protocol5-style erasure.

Proposed protocol6 request context:

1. Vercel verifies the Supabase JWT using the existing server-side boundary. Strip incoming internal ownership fields/headers; never forward a browser-supplied owner value.
2. Derive an opaque principal from the validated issuer, subject and session identity using an unambiguous length-delimited encoding and SHA-256. This is a scoping identifier, **not an authentication credential**. Missing reliable session identity disables retention. The existing authenticated service channel carries it to Rust; do not expose it in public responses or logs.
3. The page creates a random 128-bit conversation identifier in page memory. Clear chat, reload and a new tab create a new identifier. It is not stored with chats, in URLs or in the 30-day login envelope. An identifier cannot retrieve a conversation; every request still supplies its complete authorized prompt history.
4. Rust binds the prepared receipt, dispatch, cancel and cache invalidation to that principal, conversation identifier and a random cache generation. Existing exact origin, credential, deadline, replay and exclusive-permit checks remain mandatory.
5. A trusted owner mismatch always invalidates the old state **before** the next owner's native prompt is admitted. Cache affinity never delays another eligible user or reserves the model while idle.

Vercel remains the user-authentication boundary. A cache handle is never a substitute for a JWT, service credential, account admission check or usage accounting. No account identifier or token-prefix digest belongs in public telemetry.

## One-slot state machine

Only one RAM-resident retained state is eligible. Do not add a multi-user LRU, disk save/restore, Redis or a vector database to this step.

`Empty → Computing → Retained → Computing` is allowed only after ownership, fingerprint, exact-token and native-state validation. Every mismatch takes `Retained → Erasing → Empty → Computing`. Error, Stop, cancellation, disconnect, shutdown and invalidation take `Computing/Retained → Erasing → Empty`.

Required invariants:

- `Computing` owns the existing exclusive model permit. Await producer and tokenizer quiescence before changing cache ownership or acknowledging cleanup.
- `Retained` owns no compute permit. Any different eligible request can immediately evict it. No background generation, hidden continuation or prefetch occurs.
- Initial idle TTL is a fixed **60 seconds after successful computation stops**, measured with a monotonic clock. Background account refresh does not extend it. The expiry task must serialize with admission; an old timer must never erase a newer generation. No timer means no retention.
- A successful retained finish is not an erasure proof. Proposed protocol6 receipts distinguish `computeStopped` from `conversationState: retained|erased|unknown`, include the bounded expiry and cache generation, and remain content-free. Do not reinterpret protocol5 `workerStopped` or send its existing completion proof before its existing cleanup requirements.
- An erase/expiry failure marks the candidate unavailable. Do not admit another owner, claim erasure, silently fall back to another slot, or restart production services automatically. Existing operational recovery is required.

Stop and explicit Clear chat request authenticated invalidation and preserve the UI's existing cancellation proof. Explicit sign-out attempts invalidation while the captured session is still valid. Account switching invalidates the old scope and refuses to attach it to the new scope. These calls must not revoke a newer login session or erase another cache generation.

Page closure, a crashed browser and a lost network cannot reliably deliver an invalidation request. The TTL is the fallback. Before enabling retention, notices must accurately explain that short-lived model state may remain in server RAM until invalidated or expired; no claim of immediate remote erasure on tab closure is acceptable. Chats remain absent from a durable archive. The 60-second cache lifetime and the separate 30-day browser sign-in lifetime serve different purposes.

## Exact reuse and hybrid-state proof

The generation fingerprint covers model GGUF SHA-256, native binary/revision and private-hook version, tokenizer artifact SHA-256, effective template bytes/options, mode and reasoning settings, context/rope/cache dtypes, adapters and effective generation settings. Research passages are part of the exact prompt; corpus/source changes cannot reuse a merely similar older prompt. A mode or settings change causes a conservative miss.

The first private implementation should accept only append-only reuse of a retained native token sequence. Arbitrary edits, corrections to earlier messages, truncation and a changed system instruction cause full erasure and prefill. Keep full request history as the authority; never reconstruct missing history from a cache.

The native hook must atomically report/check a generation-bound state proof: the actual processed token prefix, its position boundary, checkpoint availability and whether reuse succeeded. Compare against Rust's complete new token sequence, not decoded visible text. Terminal/control tokens, partially evaluated final tokens and chat-template boundaries make string concatenation alone insufficient. Do not log that proof or token IDs.

If the native engine must roll back to produce logits, reuse is allowed only when a compatible hybrid checkpoint exists at the required boundary. Otherwise perform full prefill. Preserve fresh per-request sampling/RNG, grammar/reasoning control and penalties rebuilt from the current prompt. Never carry the previous answer's mutable sampler state into a new answer.

Do not enable speculation to obtain rollback snapshots as a shortcut. The pinned `common_context_params_to_llama` derives `n_rs_seq` from the configured speculation type; that is a separate algorithm and memory change. [Context construction](https://github.com/ggml-org/llama.cpp/blob/0504396140d1c882f5f6ee34466a42db7ae90114/common/common.cpp#L1638-L1644), [rollback requirement](https://github.com/ggml-org/llama.cpp/blob/0504396140d1c882f5f6ee34466a42db7ae90114/common/common.h#L399-L405).

## Memory and erasure scope

Keep the current 2500 MiB model and 256 MiB gateway limits, zero model swap, 4096 context and one slot. Start a private checkpoint candidate with at most two retained checkpoints and a 64 MiB aggregate serialized-checkpoint byte ceiling, including vector overhead measured separately. These are ceilings to test, not evidence that two checkpoints fit or are sufficient. If the state cannot fit within existing limits, disable retention; do not reduce quality or increase the production allocation to hide the failure.

The byte guard must check before allocating/copying a checkpoint, including temporary peak allocation. A checkpoint count alone is not a byte bound. Keep the global prompt LRU disabled; audit that erasure clears slot tokens, all checkpoint objects, pending state proofs and Rust-owned prompt data, not only the active sequence marker. Disable native prompt/debug content logs, core dumps and slot-save routes in the candidate.

Erasure here means that the service drops and invalidates every reachable conversation state and refuses any subsequent reuse. Ordinary `clear`/`drop` operations do not prove forensic zeroization of every allocator page or physical RAM cell. Do not claim that stronger property without a separate implementation and verification. Private isolation tests must demonstrate that an evicted state is not addressable, reused or serialized.

## Public-reference embedding cache

Approved public document artifacts may be shared because their contents are public and versioned. Key each vector by the exact normalized chunk bytes, chunking policy version, source content/provenance version, encoder weights and tokenizer hashes, pooling, normalization, dimension and dtype. Atomic artifact verification must reject mixed encoder/index versions. A document replacement or source withdrawal invalidates its vectors/citations.

Keep query embeddings per request in RAM; do not persist a query cache or private history under the public artifact key. Embedding reuse speeds reference preparation, not Qwen decoding. It also does not make retrieved text trustworthy: source selection, independent support, freshness and citation checks remain required by `docs/RESEARCH-MODE.md`.

## Validation and rollout gates

All manual execution is Samsung-only in the existing bounded private Docker harness, offline except separately verified dependency acquisition. Yield to live requests; preserve AC, temperature and resource guards. Use synthetic prompts and canaries, never customer logs.

1. **Contract tests:** malformed/missing/forged owner context cannot select retained state; duplicate receipt, stale generation, old TTL task and racing invalidation cannot act on a newer answer. Simultaneous users still obey the one-compute-slot bound. Cancellation proof precedes permit release.
2. **Context tests:** append-only turns, earlier-message correction, system instruction change, mode/settings switch, code blocks, multilingual text, partial output, Retry and near-full context. Inputs and output budget match the uncached baseline exactly; no hidden context dropping or summary substitution.
3. **Native parity:** use a fixed model/artifact/build/thread setup and deterministic greedy decoding first. Require identical output token IDs for repeated uncached runs before using that fixture as a reference. Cached runs must match; an unexplained divergence disables reuse. Capture boundary logits only in the synthetic fixture: compare finite values and report max absolute/relative error, top-token ordering and margins. A tolerance is diagnostic, not permission to accept a changed answer. If the backend cannot establish stable parity, keep caching off and investigate batching/rollback before changing the gate.
4. **Sampling isolation:** identical seeds/settings receive a newly initialized sampler; different seeds are not forced to replay an old completion. No old grammar or repetition history survives owner/mode change. Quality fixtures include answers that depend on the most recent correction, not just generic fluent output.
5. **Cleanup/isolation:** Stop, browser disconnect, Clear chat, explicit sign-out, account switch, TTL, prepare failure, native restart and gateway shutdown. Synthetic owner A canaries never appear in owner B's native prompt or output. A failed erase quarantines admission. Assert no checkpoint files/dumps or raw prompt telemetry are created.
6. **Resource checks:** record peak cgroup memory, checkpoint bytes and temporary copies at the longest admitted prompt, gateway memory with the full tokenizer, CPU time and temperature. A breach rejects the candidate without widening limits.
7. **Matched latency:** alternate cold and eligible warm runs for short/long general and coding histories. Record native cached tokens, evaluated tokens, tokenization time, prompt-evaluation time, first-text delay, decode tokens/second and complete-answer time. Report medians and tail samples with counts, plus misses/fallbacks. Never call fewer generated tokens a speed improvement.
8. **Rollout:** default-off capability; completed test receipts; exact source/image/artifact hashes; factual privacy text; Vercel/Rust protocol compatibility; idle cutover and tested rollback to protocol5 erasure. No production retention until these gates pass. Disable the feature if correctness, cleanup, memory or latency benefit is unproven.

The immediate implementation order is ownership/protocol tests, bounded cache lifecycle, native proof/checkpoint byte controls, private parity and latency evidence, then an independently reviewable rollout. The current Rust tokenizer/gateway migration can complete and ship with cross-request caching disabled.
