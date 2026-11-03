# Private Rust migration candidate. Existing production images are unchanged.
FROM rust:1.90.0-slim-bookworm@sha256:64232e656c058f4468e8d024e990acff04f0fd5a5c0a88a574dc37773d7325c9 AS rust-build
WORKDIR /build/rust
COPY rust/Cargo.toml rust/Cargo.lock ./
COPY rust/offscript-backend ./offscript-backend
# Ivy Bridge supports AVX/F16C, not AVX2/FMA/BMI2. Never target the build host.
ENV CARGO_BUILD_JOBS=1 RUSTFLAGS="-C target-cpu=ivybridge"
RUN cargo fetch --locked
RUN --network=none cargo build --offline --locked --release --bin offscript-backend --jobs 1

FROM registry.fedoraproject.org/fedora:44@sha256:959833699a2fb5da1bc70b4db659ab229252c2ba1ed8e2fa29d4b30a704c0f63 AS native-build
RUN dnf -y --setopt=install_weak_deps=False install gcc-c++ cmake make git python3 && dnf clean all
COPY self-host/model.json /tmp/model.json
RUN revision=$(python3 -c 'import json,re; v=json.load(open("/tmp/model.json"))["llamaRevision"]; assert v == "0504396140d1c882f5f6ee34466a42db7ae90114"; print(v)') \
    && git init /opt/llama \
    && git -C /opt/llama remote add origin https://github.com/ggml-org/llama.cpp.git \
    && git -C /opt/llama fetch --depth=1 origin "$revision" \
    && git -C /opt/llama checkout --detach "$revision" \
    && test "$(git -C /opt/llama rev-parse HEAD)" = "$revision"
COPY scripts/patch-native-rust-input.py /tmp/patch-native-rust-input.py
RUN --network=none python3 /tmp/patch-native-rust-input.py /opt/llama
RUN --network=none cmake -S /opt/llama -B /opt/llama/build -DCMAKE_BUILD_TYPE=Release \
    -DGGML_NATIVE=OFF -DGGML_CPU_ALL_VARIANTS=OFF \
    -DGGML_AVX=ON -DGGML_F16C=ON -DGGML_AVX2=OFF -DGGML_FMA=OFF -DGGML_BMI2=OFF \
    -DGGML_AVX512=OFF -DGGML_AVX512_VBMI=OFF -DGGML_AVX512_VNNI=OFF -DGGML_AVX512_BF16=OFF -DGGML_AVX_VNNI=OFF \
    -DGGML_BLAS=OFF -DGGML_CUDA=OFF -DGGML_VULKAN=OFF \
    -DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF \
    && cmake --build /opt/llama/build --target llama-server --parallel 1

FROM registry.fedoraproject.org/fedora:44@sha256:959833699a2fb5da1bc70b4db659ab229252c2ba1ed8e2fa29d4b30a704c0f63
RUN dnf -y --setopt=install_weak_deps=False install util-linux libstdc++ libgomp && dnf clean all
WORKDIR /app
COPY --from=rust-build /build/rust/target/release/offscript-backend /usr/local/bin/offscript-backend
COPY --from=native-build /opt/llama/build/bin/ ./.runtime/llama.cpp/build/bin/
COPY self-host/model.json self-host/qwen35.jinja self-host/QWEN-TEMPLATE-LICENSE self-host/TEMPLATE-NOTICE.md ./self-host/
ENV OFFSCRIPT_ROOT=/app XDG_RUNTIME_DIR=/run/model LD_LIBRARY_PATH=/app/.runtime/llama.cpp/build/bin OFFSCRIPT_REQUIRE_THERMALS=1
# Container UID0 maps to the non-root account under the required rootless daemon.
USER 0
HEALTHCHECK --interval=15s --timeout=5s --start-period=120s --retries=3 CMD ["offscript-backend", "check-model"]
CMD ["offscript-backend", "supervise"]
