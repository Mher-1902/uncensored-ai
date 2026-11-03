# Semantic reference retrieval

Status: private ranking/verification module implemented; encoder execution, real corpus creation, Research-mode integration and deployment remain pending. No embedding model has been downloaded or activated by this change. The synthetic-vector tests check mathematics and boundaries; they are not a semantic-quality or speed benchmark.

## Product decision

Start with trusted public technical references in explicit Research mode. The first curated set should cover Python, Rust and browser development using official documentation from `https://docs.python.org`, `https://doc.rust-lang.org` and `https://developer.mozilla.org`. This is a deliberately bounded corpus, not live web search or universal factual coverage. Corpus preparation still needs source/version/licence review before publishing an artifact. Keep Fast mode direct, and leave personal chats, uploads, private repositories, credentials and account data out of every index.

Retrieval supplies relevant reference passages to the existing Qwen generator; it does not retrain it or turn it into a mixture-of-experts model. A bidirectional sentence encoder reads the query/reference text to produce search vectors. The causal generator remains responsible for writing the answer. These two models require their own correct tokenizer and configuration; Qwen token IDs must never be sent to the encoder.

`all-MiniLM-L6-v2` is the first CPU candidate: an English sentence encoder producing 384-dimensional vectors. Its published usage requires attention-masked mean pooling and L2 normalization; its sentence-transformer context is 256 wordpieces. That is a retrieval-input bound, not an expansion of Qwen's 4096-token context. Armenian or multilingual retrieval quality is unproven. [Model card](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2), [pooling configuration](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/blob/main/1_Pooling/config.json).

The model selection remains provisional until it passes the exact Samsung compatibility, memory, latency and retrieval-quality gates below. Do not substitute an unrelated vector or claim embeddings were computed when only the ranking layer is available.

## Implemented boundary

`rust/offscript-backend/src/retrieval.rs` provides:

- `ReferenceIndex::load(directory, &TrustedArtifacts)` for an immutable public corpus artifact, pinned independently by a reviewed manifest SHA-256, encoder fingerprint and corpus version.
- `ReferenceIndex::search(query_text, query_embedding, encoder_fingerprint, options)` for a query embedding supplied by a **trusted, separately verified encoder adapter**. The fingerprint identifies configuration, not proof of model execution or authentication. Never expose an endpoint that trusts a browser's asserted fingerprint/vector.
- Bounded results containing stable passage ID, exact source URL/text/hash, corpus/encoder versions and the numerical ranking components. No network client, document fetch, generation call, query cache or persistent query history is part of this module.

The loader verifies fixed `manifest.json` and `passages.jsonl` filenames. The directory must be an owner-controlled, read-only immutable artifact mount. It rejects a symlink directory/file and checks opened-file identity on Unix; checksum validation covers the bytes actually parsed. This is not a sandbox for hostile users to mutate artifact paths during loading.

### Artifact contract

The strict manifest fields are `schema: 1`, `format: "offscript-public-references-jsonl-v1"`, `scope: "public"`, `corpus_version`, `corpus_sha256`, `passage_count` and `encoder`. Unknown fields are rejected. An artifact cannot make itself trusted merely by providing matching hashes: the expected manifest digest and encoder identity come from deployment configuration.

The encoder identity contains model ID, immutable 40-character revision, exact weights/tokenizer/config SHA-256 values, dimension384, maximum sequence length256, `attention_masked_mean` pooling, `l2` normalization and `f32` vectors. Its fingerprint is SHA-256 over the versioned, length-prefixed field sequence defined in the module. Hashes and revisions must be lowercase hexadecimal. Real verified hashes must be supplied during corpus production; no placeholder corpus is installed.

Each canonical LF-terminated JSONL record has `id`, `title`, `source_url`, `text`, `text_sha256` and a 384-value `embedding`. The text checksum covers exact UTF-8 bytes before any later rendering. Passage IDs are unique bounded ASCII identifiers; a source URL may have multiple distinct passages. The module rejects missing/extra lines, duplicate IDs, unknown fields, non-finite vectors, zero vectors, wrong dimensions and vectors whose L2 norm differs from1 by more than0.002. The tolerance only accommodates floating-point rounding; the loader does not silently repair invalid vectors.

Boundaries:

| Resource | Limit |
| --- | --- |
| Manifest | 16 KiB |
| JSONL artifact | 96 MiB |
| Passages | 1–10,000 |
| One JSONL line | 32 KiB, bounded before allocation growth |
| One passage text / title / URL / ID | 4096 /256 /2048 /96 UTF-8 bytes |
| Total retained text and metadata strings | 16 MiB |
| Allowed public HTTPS origins | 1–16, exact canonical origins |
| Query | 2048 UTF-8 bytes, at most64 unique lexical terms of128 bytes each |
| Returned passages | 1–8 |

Origin matching is exact, not a hostname suffix test. User information, HTTP, nondefault ports, whitespace/control characters, local domains and IP-literal URLs are rejected. This allowlist is a provenance boundary for already prepared documents, not an SSRF claim: the module makes no outbound request. Corpus builders need their own reviewed fetch/redirect/DNS/size handling if added later. Render returned text and metadata as escaped content; never treat them as HTML, executable code or trusted model instructions.

10,000 raw384-dimensional f32 vectors occupy about14.65 MiB before text, string/vector capacities, bookkeeping, encoder weights, tensors or the existing Qwen tokenizer. The configured bounds do not prove the combined gateway fits256 MiB. Actual peak process/cgroup memory is a release gate.

### Ranking

For accepted normalized vectors the module computes cosine similarity with f64 accumulation and the measured vector norms. A configurable minimum cosine filters candidates before ranking. The default ranking is:

`0.8 × max(cosine, 0) + 0.2 × unique-query-term-coverage`

Lexical coverage counts how many distinct lowercased alphanumeric query terms appear in the passage title/text, divided by the number of query terms. Repetition does not raise that score. It is a simple, explicit lexical companion, not BM25 or a learned reranker. Ties resolve by cosine, lexical coverage and stable passage ID; artifact input order cannot change an exact tie. The default cosine threshold0.25 is a provisional filter to calibrate, **not** a confidence probability or factuality guarantee. Zero qualifying passages is a valid result.

Dense and lexical retrieval have different strengths; a further cross-encoder can rerank a small candidate set, but adds computation. We have not added that model or cost to the Samsung. [Sentence Transformers retrieve/rerank documentation](https://www.sbert.net/examples/sentence_transformer/applications/retrieve_rerank/README.html).

## CPU runtime investigation

No new runtime dependency is added to the locked Rust workspace in this step.

- **Candle:** the official Rust BERT example supports CPU operation, selects MiniLM, and shows masked pooling plus L2 normalization. Its core defaults do not enable CUDA, Metal or MKL. This makes a pinned pure CPU build a plausible first adapter to investigate; it is not evidence that the exact graph/dependency stack works or performs well on the Samsung. Do not copy the example's moving default revision, tracing, prompt printing or network downloads into production. [BERT example](https://github.com/huggingface/candle/blob/main/candle-examples/examples/bert/main.rs), [core features](https://github.com/huggingface/candle/blob/main/candle-core/Cargo.toml).
- **Tract:** its official changelog records an AVX-without-AVX2/FMA kernel family for Sandy/Ivy Bridge under release0.23.5. That corrects an earlier research note attributing the addition to0.23.7. The same changelog also records a Rust1.91 minimum-version increase, while this candidate uses Rust1.90. Exact release/toolchain and ONNX graph/operator compatibility must therefore be checked before choosing it. Kernel microbenchmark claims are not MiniLM measurements. [Primary changelog](https://github.com/sonos/tract/blob/main/CHANGELOG.md).
- **Scala/Java:** use the current offline preparation/artifact tooling where it offers a concrete benefit. Do not add an always-on JVM or rewrite the Rust scheduler to accommodate another language. A Java inference runtime would still require separately verified native CPU support and native-memory accounting; Java heap size alone would not bound the service.

The Samsung has AVX/F16C and lacks AVX2/FMA. An export or package named AVX2 is not a compatible optimization by assumption. Any adapter must use an exact pinned source/toolchain/weight configuration, target the actual CPU, run without paid providers or Mac inference, and preserve existing CPU/RAM/zero-swap and thermal limits. No weight download or online inference is included in this module's validation.

## Remaining integration gates

1. Select and verify the exact CPU encoder revision, tokenizer/config/weights and operator implementation. On Samsung in the bounded private Docker harness, compare tokenization, attention masks, masked pooling and normalized embeddings against a trusted reference for short/long text, padding and Unicode. Reject oversized input explicitly; do not silently truncate a user's question. Prepare overlapping reference chunks that fit the encoder tokenizer, with provenance and source licences preserved.
2. Build the initial approved public corpus atomically using the same encoder. Preserve content versions, source timestamps, hashes and stable citation IDs. Review source changes/withdrawals; mixed encoder/corpus artifacts must fail closed. Public embedding reuse may cache immutable document artifacts; query history remains unpersisted. See `rust/CACHE-CONTRACT.md`.
3. Evaluate retrieval on fixed realistic technical queries, synonyms, exact API names, misleading keywords, no-answer cases and stale/conflicting documents. Measure recall/top-result relevance and source coverage; tune thresholds without claiming numerical similarity is truth. Record language limitations. Synthetic basis-vector tests cannot establish this quality.
4. Measure cold/warm encoding, retrieval latency, peak memory and sustained temperature while preserving live-request priority. Fit within existing allocations; do not run encoder and generator concurrently if that harms service or exceeds limits. A lightweight index does not imply an affordable encoder. Disable the feature when it cannot fit.
5. Add explicit Research orchestration only after those gates. Allocate a bounded reference context within the same4096-token generator limit without dropping user history. If passages do not fit, return a clear limitation. Treat excerpts as untrusted reference data, preserve source IDs and attach citations only to claims actually supported by those excerpts. Report retrieval failure/no coverage instead of inventing a search result.
6. Apply the independent-source/freshness behavior in `RESEARCH-MODE.md`. Multiple chunks from one publisher are not independent sources. The selected small technical corpus cannot satisfy every general factual or current-events question; do not label it live internet research.
7. Release only after source/tests, exact artifact/resource receipts, privacy truth, UI verification and rollback. The current Rust gateway/tokenizer migration can ship with retrieval unused. No Research UI option or provider recipient is activated by this module.
