# Docker backend

Production runs on the Samsung. Its rootless Docker daemon, containers, private SSH tunnel and boot services run independently of the Mac. Docker Desktop on the Mac is optional development tooling and can remain stopped.

The Compose stack has a CPU-only model, a small Node gateway and a bounded Caddy ingress proxy. All images use verified registry digests. The model builds the revision in `self-host/model.json` for the Samsung's AVX/F16C CPU, without AVX2, FMA, BMI2 or GPU dependencies. Weights remain a read-only host mount and are never baked into an image or sent to CI.

The gateway shares the model's private network namespace so inference and slot endpoints remain on loopback. The model and gateway use an internal network without external egress. Rootless Docker on the Samsung did not publish ports from that internal network, so a separate Caddy proxy joins it and an ingress bridge. Only the proxy's port 8080 maps to host `127.0.0.1`; it forwards exclusively to the gateway, with immediate stream flushing. Caddy's admin interface, automatic TLS/config persistence and request logs are disabled for this private profile. TLS terminates at the separately configured tunnel. [Caddy streaming proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).

Container filesystems are read-only, capabilities are dropped, core dumps and application swap are disabled, and container logs rotate. The gateway and proxy use non-root container users; the model's container UID 0 maps to the non-root host account through the required rootless daemon. No application container mounts the Docker socket. Add narrowly scoped outbound access when authenticated GPU/database integration requires it.

The model requires working thermal readings and stops at 85C or when sensors disappear. It has no automatic hot restart. Boot preflight requires AC power, adequate RAM and a CPU below 70C. Rootless Docker must report cgroup v2/systemd and enforce the configured CPU/memory limits. Inspect these on the actual host; configuration files alone do not establish enforcement.

## Prepare and validate

Install official Docker Engine, Compose and rootless extras using Docker's signed Fedora repository, then run `dockerd-rootless-setuptool.sh install` as the service account and enable its user service with lingering. Preserve existing keys and configuration. [Fedora installation](https://docs.docker.com/engine/install/fedora/), [rootless setup](https://docs.docker.com/engine/security/rootless/).

Prepare the verified weights using the existing guarded host preparation. On the Samsung, create a bounded image builder:

```sh
docker buildx create --name offscript-build --driver docker-container \
  --driver-opt cpu-period=100000,cpu-quota=80000,memory=4g,memory-swap=4g,restart-policy=no,default-load=true
docker compose build --builder offscript-build
```

Use one compiler worker and watch host temperatures while building; pause the BuildKit container at 80C and resume below 70C. The builder's limits apply to the compiling container; limiting only the Docker client does not bound the build. [Docker builder limits](https://docs.docker.com/build/builders/drivers/docker-container/).

The CPU profile is for Linux x86_64 on the Samsung. An Apple Silicon Mac can build/test the gateway image separately; the CPU model requires its documented host features and thermal sensors.

Before switching serving mode, stop the native services, run the boot preflight, then start Compose and verify local health and real streamed inference. Never run two copies of the model at once on this laptop:

```sh
systemctl --user stop offscript-web offscript-model
python3 docker/verify-host.py
docker compose up -d --wait --wait-timeout 180
docker compose ps
curl --fail http://127.0.0.1:8080/api/health
```

If container validation fails, stop Compose and restart the native model/web services. Check Direct and Reasoned responses, cache erasure, resource enforcement and temperatures before enabling unattended containers. The current Reasoned response deadline remains a separately tracked limitation of this CPU profile.

Once a reviewed release passes real-host checks, copy `self-host/offscript-containers.service` into the user's unit directory, disable native model/web auto-start, and enable the container unit. Keep the private tunnel enabled. A stopped or unhealthy model needs operator attention; a oneshot unit's `active` state alone does not prove container health. Monitor `docker compose ps` and gateway health.

CI validates the pinned proxy configuration, builds both application images, exercises gateway tests in the actual non-root read-only runtime image, and checks the pinned model binary. It does not download weights or establish inference quality. Publishing signed/SBOM-scanned images by digest and deploying them through the restricted reviewed-commit entry point is the next delivery increment; the existing native deploy script refuses an active container unit.
