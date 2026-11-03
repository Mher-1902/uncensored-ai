# Offline Scala / Java artifact preparation

Private build-tool candidate. It is not wired into production deployment and
does not replace the working Python exporter until full-model parity passes.
The request path stays Rust; no JVM, Scala compiler server, Spark or Akka process
runs alongside inference. There is no new prediction engine or paid dependency.

Scala3 owns the command orchestration. Java21 streams the GGUF header, checksums
and JSON output. The tool accepts explicit local files, performs no downloads,
does not read customer prompts, and exits after its command completes.

## Pinned toolchain

- Scala CLI **1.18.0**, official Linux x86_64 release.
- Eclipse Temurin **21.0.13+9**, official Linux x64 JDK. The command checks this
  exact Java feature/update/build before processing files.
- Scala **3.3.9 LTS**, published Maven compiler.
- **Jackson core2.18.7**, streaming JSON only; no databind, polymorphic loading or
  serialization of arbitrary user classes.

Official URLs and archive/JAR SHA256 values are recorded in
`toolchain-lock.json`. Prefetch and verify the toolchain/dependency caches in a
separate bounded Samsung build container. Never install, compile or execute this
toolchain on the Mac. Use the existing CPU/memory/no-swap, AC and temperature
guards; yield to live requests. Do not treat this tool's process limits as a
replacement for the container limits.

After prefetching, all compilation/validation should use no network. Set
`JAVA_HOME` to the verified extracted JDK and `COURSIER_CACHE` / `SCALA_CLI_HOME`
to the isolated prefetched cache locations. Explicitly use `--server=false` so
there is no persistent Bloop compiler server. For both compilation and the tool:

Scala CLI with `--server=false` does not emit Java bytecode. Compile the Java
source explicitly with the pinned JDK, then supply those classes to Scala.
`JACKSON_JAR` below must refer to the verified Jackson JAR whose SHA256 appears
in `toolchain-lock.json`; `JAVA_CLASSES` must be an owner-controlled, new build
directory inside the private build container.

```sh
export JAVA_TOOL_OPTIONS='-Xms16m -Xmx384m -XX:ActiveProcessorCount=1 -XX:+UseSerialGC'
mkdir "$JAVA_CLASSES"
javac --release 21 -cp "$JACKSON_JAR" -d "$JAVA_CLASSES" \
  jvm/src/main/java/org/offscript/artifacts/ArtifactExporter.java
scala-cli --power run jvm/project.scala jvm/src/main/scala \
  --classpath "$JAVA_CLASSES" --server=false --jvm system --offline \
  --main-class org.offscript.artifacts.ArtifactTool -- \
  export-tokenizer --model /models/model.gguf --config /source/self-host/model.json \
  --output /output/tokenizer-new
```

`/output` must already exist, and `/output/tokenizer-new` must be absent. Paths
must not traverse symlinks. Use an owner-controlled output parent with a local
filesystem supporting atomic directory moves. The tool creates an exclusive
output lock, writes a private sibling staging directory, verifies all artifacts,
and publishes the complete directory with one atomic move. It refuses to replace
existing output. A stale lock requires operator inspection; the tool will not
delete or bypass another invocation's lock.

The export preserves the exact selected GGUF checksum and size,320 tensors,
248320 vocabulary IDs,247587 merge ranks, Qwen3.5 splitting and special-token
types3/4. No normalizer, implicit prefix, padding or truncation is added. The
32MiB metadata/output bounds are independent of the model's tensor size. SHA256
uses bounded buffers rather than reading the1.27GB model into Java memory.

The published files are `tokenizer.json`, `manifest.json`, `provenance.json` and
`provenance.sha256`, each read-only and readable by the unprivileged Rust gateway.
The existing Rust manifest schema is unchanged; the separate provenance binds
the source model/config, tokenizer and manifest checksums plus tool versions.
Different JSON formatting may produce a different valid tokenizer checksum;
compare semantic data and actual token IDs, never substitute the Python hash.

Verify a JVM-generated artifact set:

```sh
scala-cli --power run jvm/project.scala jvm/src/main/scala \
  --classpath "$JAVA_CLASSES" --server=false --jvm system --offline \
  --main-class org.offscript.artifacts.ArtifactTool -- \
  verify-artifacts --model /models/model.gguf --config /source/self-host/model.json \
  --artifacts /output/tokenizer-new
```

Verification checks source identity, every vocabulary ID/merge rank/special
token, exact tokenizer options, actual file hashes and provenance. It rejects
duplicate JSON fields, symlinks, extra tokenizer behavior and oversize inputs.
It does not run inference or modify the supplied artifact directory.

## Validation before replacing Python preparation

Run the synthetic contracts only inside the bounded Samsung container:

```sh
scala-cli --power run jvm/project.scala jvm/src/main/scala jvm/tests \
  --classpath "$JAVA_CLASSES" --server=false --jvm system --offline \
  --main-class org.offscript.artifacts.ArtifactChecks
```

Then use the existing Python exporter as an independent oracle on the exact
pinned model, writing to a different new output directory. Compare decoded
`tokenizer.json` semantic values, manifest fields other than the actual-byte
tokenizer hash, and Rust token-ID results across the multilingual/code/special
and continuation fixtures. Independently hash both generated files and verify
their respective manifest values. Record peak heap/RSS, wall time, cleanup and
the unchanged production container identities. Include negative tests for
tampered model/config, artifacts and provenance before selecting JVM preparation.

Python fallback and current Docker build steps remain intact. Download/bootstrap
and native patch preparation are intentionally not migrated in this version.

Private Samsung validation on 2 November 2026 passed all 12 synthetic contract
groups, the exact selected-model export/verification, and comparison with the
independent Python exporter. Both produced the same 10,085,508 tokenizer bytes
and SHA256 `870f52c96c79b41a014df678d5b7078850e11607914adeed854c0ec424f3b407`.
Five additional full-model checks rejected a swapped manifest model hash,
swapped provenance config/tokenizer hashes even after recomputing their local
checksums, a corrupted provenance checksum, and changed tokenizer bytes. They
preserved the original artifacts and did not replace the altered copies.

These checks ran offline after public dependency preparation, with 0.25 CPU,
1 GiB container memory, 384 MiB maximum heap and no swap. Production container
identities stayed unchanged and no prediction request was sent. This validates
artifact preparation; runtime tokenizer parity, application latency and capacity
remain separate gates.
