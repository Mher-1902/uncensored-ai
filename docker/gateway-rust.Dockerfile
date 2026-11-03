FROM rust:1.90.0-slim-bookworm@sha256:64232e656c058f4468e8d024e990acff04f0fd5a5c0a88a574dc37773d7325c9 AS build
WORKDIR /src
COPY rust/ ./
ENV CARGO_BUILD_JOBS=1 RUSTFLAGS="-C target-cpu=ivybridge"
# Dependency acquisition is separate from offline source compilation.
RUN cargo fetch --locked
RUN --network=none cargo build --offline --locked --release --package offscript-backend

FROM debian:bookworm-slim@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3
WORKDIR /app
COPY --from=build --chmod=0755 /src/target/release/offscript-backend /usr/local/bin/offscript-backend
COPY --chmod=0644 self-host/model.json ./self-host/model.json
ENV OFFSCRIPT_ROOT=/app OFFSCRIPT_TOKENIZER_DIR=/app/.data/tokenizer HOST=0.0.0.0 PORT=8080 TOKENIZERS_PARALLELISM=false RAYON_NUM_THREADS=1
USER 65532:65532
HEALTHCHECK --interval=15s --timeout=5s --start-period=90s --retries=3 CMD ["offscript-backend", "check-gateway"]
CMD ["offscript-backend", "gateway"]
