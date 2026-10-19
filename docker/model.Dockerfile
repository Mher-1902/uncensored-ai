FROM registry.fedoraproject.org/fedora:44@sha256:959833699a2fb5da1bc70b4db659ab229252c2ba1ed8e2fa29d4b30a704c0f63 AS build
RUN dnf -y --setopt=install_weak_deps=False install gcc-c++ cmake make git python3 && dnf clean all
COPY self-host/model.json /tmp/model.json
RUN revision=$(python3 -c 'import json,re; v=json.load(open("/tmp/model.json"))["llamaRevision"]; assert re.fullmatch("[0-9a-f]{40}",v); print(v)') \
    && git init /opt/llama \
    && git -C /opt/llama remote add origin https://github.com/ggml-org/llama.cpp.git \
    && git -C /opt/llama fetch --depth=1 origin "$revision" \
    && git -C /opt/llama checkout --detach "$revision" \
    && test "$(git -C /opt/llama rev-parse HEAD)" = "$revision"
# Samsung Ivy Bridge: AVX/F16C, no AVX2/FMA/BMI2. One compiler worker.
RUN cmake -S /opt/llama -B /opt/llama/build -DCMAKE_BUILD_TYPE=Release \
    -DGGML_NATIVE=OFF -DGGML_CPU_ALL_VARIANTS=OFF \
    -DGGML_AVX=ON -DGGML_F16C=ON -DGGML_AVX2=OFF -DGGML_FMA=OFF -DGGML_BMI2=OFF \
    -DGGML_AVX512=OFF -DGGML_AVX512_VBMI=OFF -DGGML_AVX512_VNNI=OFF -DGGML_AVX512_BF16=OFF -DGGML_AVX_VNNI=OFF \
    -DGGML_BLAS=OFF -DGGML_CUDA=OFF -DGGML_VULKAN=OFF \
    -DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF \
    && cmake --build /opt/llama/build --target llama-server --parallel 1

FROM registry.fedoraproject.org/fedora:44@sha256:959833699a2fb5da1bc70b4db659ab229252c2ba1ed8e2fa29d4b30a704c0f63
RUN dnf -y --setopt=install_weak_deps=False install python3 util-linux libstdc++ libgomp && dnf clean all
WORKDIR /app
COPY --from=build /opt/llama/build/bin/ ./.runtime/llama.cpp/build/bin/
COPY self-host ./self-host
ENV XDG_RUNTIME_DIR=/run/model LD_LIBRARY_PATH=/app/.runtime/llama.cpp/build/bin OFFSCRIPT_REQUIRE_THERMALS=1 PYTHONDONTWRITEBYTECODE=1
# Container UID 0 maps to the non-root host account under the required rootless daemon.
USER 0
HEALTHCHECK --interval=15s --timeout=5s --start-period=120s --retries=3 CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8081/health',timeout=4)"
CMD ["python3", "self-host/run_model.py"]
