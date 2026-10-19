# Offscript on the Samsung

The actual Samsung inspected over SSH on October 4, 2026 reports an Intel i7-3517U, two physical cores, four logical threads, 7,554 MiB RAM and Fedora 42. AVX and F16C are supported; AVX2, FMA and BMI2 are not. The public website is hosted separately and stays available while the laptop is off. Replies require the Fedora laptop to remain awake, connected and cool. Model compilation and verification are separate from a successful inference test.

The selected model is **HauhauCS Qwen3.5 2B Aggressive, Q4_K_M**, 1,270,808,032 bytes. Its source revision, SHA-256, official Qwen3.5 template and llama.cpp revision are locked in `self-host/model.json`. See [the current profile and measured smoke checks](MODEL-PROFILE.md). This remains CPU-only inference on the Samsung; vLLM's documented x86 CPU requirements exclude its AVX-only processor.

The hardware description above and the native-service/tunnel examples below record the original October 4 setup. The current server runs Fedora 44 with rootless Docker and a credential-protected gateway; use [Docker deployment](DOCKER.md) and [Vercel hosting](VERCEL.md) for current operations.

## Prepare on Fedora

Use a currently supported Fedora installation. Commands below run on the Samsung, not on the development Mac.

```sh
git clone https://github.com/Mher-1902/uncensored-ai.git
cd uncensored-ai
sudo dnf install git cmake gcc-c++ make python3
python3 self-host/bootstrap.py
export PATH="$PWD/.runtime/node/bin:$PATH"
node --version
npm ci
npm run fedora:inspect
npm run build
npm test
npm run fedora:prepare
```

Node.js 24+ is required. The bootstrap installs pinned, checksum-verified official Node and Tailscale binaries inside `.runtime`, without replacing the system Node installation or requiring root. The read-only inspection reports real available RAM, swap use, CPU flags and temperatures. Preparation refuses less than 3,500 MiB physical memory or 2,150 MiB available memory. Close desktop apps first; swap does not count. It builds CPU-only llama.cpp with AVX/AVX2/FMA/F16C/BMI2 enabled **only if the CPU actually supports them**. One compile worker limits peak load. Compilation pauses at 80°C and resumes at 70°C; the model is downloaded separately, so libcurl development headers are unnecessary.

A startup memory check is not an absolute crash guarantee. Verify measured RSS, temperatures and swap use under load. If `fedora:inspect` finds no usable thermal sensor, inspect cooling manually before unattended use. This project cannot repair an old fan, blocked vents or a failing battery.

## Start and verify

```sh
npm run fedora:model
```

In a second terminal:

```sh
npm start
curl http://127.0.0.1:8080/api/health
npm run benchmark
```

The model listens only on `127.0.0.1:8081`. The gateway listens on `127.0.0.1:8080`. Only expose the gateway. The default profile uses two CPU threads, one slot, a 4,096-token total context, 128-token logical prefill batches and 64-token microbatches. It keeps F16 KV precision and a pinned official Qwen chat template; the explicit template keeps Direct/Reasoned behavior pinned and independently verified. See `self-host/TEMPLATE-NOTICE.md` for provenance and license. It does not distill, prune layers or silently cut off old turns. Exact token counting reserves space for generation, including extra room for thinking. Too-long conversations receive a clear error.

Direct mode is the current UI default. Direct mode uses Qwen's documented thinking switch, with its own recommended sampler. It is an explicit quality/latency tradeoff. Reply-length controls bound output; an exhausted output budget is reported. Generating many thinking tokens on two old cores can still take a long time.

Temperature polling stops the model at 85°C; there is no automatic hot restart. The gateway also checks CPU temperature during requests. This conservative threshold depends on working sensors and is not a cooling guarantee. No power-management settings, firmware limits or protections are disabled.

## User services

Clone to `~/uncensored-ai` for the supplied paths. The bootstrap and preparation commands do not install or enable services automatically. Install the model and gateway after preparation:

```sh
mkdir -p ~/.config/systemd/user
cp self-host/offscript-model.service self-host/offscript-web.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user start offscript-model offscript-web
systemctl --user status offscript-model offscript-web
```

The current model service has a 2,500 MiB hard cgroup memory ceiling, no swap allowance, an 80% CPU ceiling (0.8 of one CPU's aggregate time), lower scheduling priority and no automatic restart after a thermal stop. The gateway has a separate 256 MiB ceiling and uses the project-local Node binary. Verify limits with `systemctl --user show offscript-model -p MemoryMax -p MemorySwapMax -p CPUQuotaPerSecUSec`. Model loading and readiness must succeed inside these limits before enabling services at login. `LimitCORE=0` prevents service core dumps. These are user services; without lingering, availability across full logout or reboot depends on an active login. Direct terminal commands do not have the unit's cgroup limits; use the supplied service for the Samsung's public serving profile. Do not enable lingering or change sleep behavior until the cooling and unattended use are assessed.

## Public HTTPS without buying a domain

The existing `chatgpt.site` address serves the public frontend. For a personal, non-commercial deployment, **Tailscale Personal + Funnel** is an available free backend route with a `ts.net` hostname and managed TLS. It requires your own account and device setup. Funnel is in beta and has provider bandwidth limits; no free option supplies a production SLA or unlimited compute.

The supplied tunnel runs Tailscale in its documented userspace mode, without a root daemon or system VPN interface. Its state directory contains credentials and must remain private and outside the repository. Start it, sign in through the URL printed by `up`, then enable Funnel through Tailscale's approval page as described in [the official guide](https://tailscale.com/docs/features/tailscale-funnel):

```sh
install -d -m 700 ~/.local/state/offscript/tailscale
cp self-host/offscript-tunnel.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user start offscript-tunnel
.runtime/tailscale/tailscale --socket="$XDG_RUNTIME_DIR/offscript-tailscale/tailscaled.sock" up --hostname=offscript-samsung --accept-dns=false
.runtime/tailscale/tailscale --socket="$XDG_RUNTIME_DIR/offscript-tailscale/tailscaled.sock" funnel --bg http://127.0.0.1:8080
.runtime/tailscale/tailscale --socket="$XDG_RUNTIME_DIR/offscript-tailscale/tailscaled.sock" funnel status
```

Funnel makes the gateway publicly accessible, without visitors joining your tailnet. Its HTTPS hostname depends on your device/account; never invent one. Test streaming through the actual hostname before connecting the frontend. The gateway's `PUBLIC_ORIGIN` must remain the exact published website origin. The inference port and slot/tokenizer/model-admin endpoints stay private. To stop public access, run the same socket-qualified Tailscale command with `funnel reset`.

On the website development checkout, use the real returned hostname:

```sh
node scripts/connect-model.mjs https://YOUR-VERIFIED-FUNNEL-HOST/api
npm run build
```

The connection script verifies health and CORS before changing configuration. The build includes only that HTTPS origin in CSP. Publish through the normal Sites workflow. Do not commit credentials; no backend secret is needed in the browser for this public service.

Cloudflare Quick Tunnels are **not** a substitute for this streaming setup: their documentation explicitly says they do not support SSE and their hostnames change. A named Cloudflare Tunnel can be used if you already own a suitable domain, but domain registration is separate.

## Load tests and quality checks

Start with a single visitor and watch real thermals and memory:

```sh
BENCH_RUNS=5 BENCH_CONCURRENCY=1 npm run benchmark
BENCH_RUNS=5 BENCH_CONCURRENCY=1 BENCH_REASONED=true npm run benchmark
```

After cooling and stability checks, collect at least 20 runs and test a burst of 10 clients. A single inference slot serializes those requests; queue delay can dominate. The gateway's bounded queue (32 waiting requests, five-minute queue/generation deadlines) prevents unbounded RAM use and gives overload errors. These are resource protections, not a claim that ten concurrent generations are fast. If sustained use is too slow, move inference to stronger hardware; caching visitors' chats or silently replacing reasoning with a shortcut is not the solution.

The benchmark prints only aggregate timing and token metrics, using a fixed synthetic prompt. It measures first stream token, first answer token, total response time, p50/p95 and observed decode throughput. It does not save prompts or replies. See the [handoff README](../README.md) for completed five-sample measurements and the interrupted final-profile comparison. Those small samples do not establish a reliable p95, Reasoned-mode quality, ten-client capacity or unattended stability. The Samsung became unreachable at handoff, and the owner requested no further development or deployment.

Manually check arithmetic (17×23=391), an explanation of seasons, a short Python function, English/Armenian/Russian prompts relevant to you, an ambiguous request, and a factual question whose answer you know. Compare Reasoned and Direct. Small models and abliteration can reduce quality; publisher refusal tests are not general intelligence benchmarks.

## Ephemeral data

Chats live only in browser memory and request-local gateway/inference memory. Leaving, reloading or clearing aborts the request. The server has no chat database, conversation identifiers, prompt logs or disk prompt cache. Cross-request prompt caching is disabled. The gateway erases slot 0 before and after each generation and stops accepting inference if erasure fails. This pinned llama.cpp revision requires `--slot-save-path` even for erasure: startup verifies the path is private and backed by tmpfs, and the gateway never calls save/restore. Administrative endpoints remain loopback-only. Only weights, compiled software and private tunnel credentials are stored.

Garbage collection/cache erasure is not secure physical RAM wiping. Operating-system state and hosting/tunnel providers have separate policies. On the supplied services application swap and core dumps are disabled; diagnostic logs contain startup/thermal status, not prompts. Do not claim anonymity or guaranteed zero infrastructure logs.
