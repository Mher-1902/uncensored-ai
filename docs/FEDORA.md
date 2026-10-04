# Offscript on the Samsung (4 GB RAM)

This is a prepared setup, not a claim that inference has been tested on your Samsung. The public website is hosted separately and stays available while the laptop is off. Replies require the Fedora laptop to remain awake, connected and cool.

The selected model is **Huihui Qwen3 1.7B abliterated v2, importance-matrix Q4_K_M**, 1,107,405,664 bytes. Its source revision, SHA-256 and llama.cpp revision are locked in `self-host/model.json`. This is a practical memory/quality compromise, not a proved best model. The requested lukey03 9B Q4 weighs 5,627,044,704 bytes; it exceeds the laptop's physical RAM before runtime allocations.

## Prepare on Fedora

Use a currently supported Fedora installation. Commands below run on the Samsung, not on the development Mac.

```sh
git clone https://github.com/Mher-1902/uncensored-ai.git
cd uncensored-ai
sudo dnf install git cmake gcc-c++ make python3 nodejs
node --version
npm ci
npm run fedora:inspect
npm run build
npm test
npm run fedora:prepare
```

Node.js 24+ is required. The read-only inspection reports real available RAM, swap use, CPU flags and temperatures. Preparation refuses less than 3,500 MiB physical memory or 2,150 MiB available memory. Close desktop apps first; swap does not count. It builds CPU-only llama.cpp with AVX2/FMA/F16C enabled **only if the CPU actually supports them**. Sandy Bridge does not support AVX2. One compile worker limits peak load.

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

The model listens only on `127.0.0.1:8081`. The gateway listens on `127.0.0.1:8080`. Only expose the gateway. The default profile uses two CPU threads, one slot, a 4,096-token total context, 128-token logical prefill batches and 64-token microbatches. It keeps F16 KV precision and the model's embedded chat template; it does not distill, prune layers or silently cut off old turns. Exact token counting reserves space for generation, including extra room for thinking. Too-long conversations receive a clear error.

Reasoned mode remains the default. Direct mode uses Qwen's documented thinking switch, with its own recommended sampler. It is an explicit quality/latency tradeoff. Reply-length controls bound output; an exhausted output budget is reported. Generating many thinking tokens on two old cores can still take a long time.

Temperature polling stops the model at 85°C; there is no automatic hot restart. The gateway also checks CPU temperature during requests. This conservative threshold depends on working sensors and is not a cooling guarantee. No power-management settings, firmware limits or protections are disabled.

## Optional user services

Clone to `~/uncensored-ai` for the supplied paths. These are user units; no service is installed or enabled automatically.

```sh
mkdir -p ~/.config/systemd/user
cp self-host/offscript-*.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user start offscript-model offscript-web
systemctl --user status offscript-model offscript-web
```

The model has a 2,500 MiB hard cgroup memory ceiling, no swap allowance, 180% CPU ceiling, lower scheduling priority and no automatic restart after a thermal stop. The gateway has a separate 256 MiB ceiling. Verify limits with `systemctl --user show offscript-model -p MemoryMax -p MemorySwapMax -p CPUQuotaPerSecUSec`. Model loading and readiness must succeed inside these limits before enabling services at login. `LimitCORE=0` prevents service core dumps. Do not enable lingering or change sleep behavior until the cooling and unattended use are assessed.

## Public HTTPS without buying a domain

The existing `chatgpt.site` address serves the public frontend. For a personal, non-commercial deployment, **Tailscale Personal + Funnel** is an available free backend route with a `ts.net` hostname and managed TLS. It requires your own account and device setup. Funnel is in beta and has provider bandwidth limits; no free option supplies a production SLA or unlimited compute.

Install from [Tailscale's Fedora instructions](https://tailscale.com/download/linux/fedora), sign in on the laptop, and enable Funnel as described in [the official guide](https://tailscale.com/docs/features/tailscale-funnel). After local streaming works:

```sh
tailscale funnel --bg http://127.0.0.1:8080
tailscale funnel status
```

Funnel makes the gateway publicly accessible, without visitors joining your tailnet. Its HTTPS hostname depends on your device/account; never invent one. Test streaming through the actual hostname before connecting the frontend. The gateway's `PUBLIC_ORIGIN` must remain the exact published website origin. The inference port and slot/tokenizer/model-admin endpoints stay private. To stop public access: `tailscale funnel reset`.

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

The benchmark prints only aggregate timing and token metrics, using a fixed synthetic prompt. It measures first stream token, first answer token, total response time, p50/p95 and observed decode throughput. It does not save prompts or replies. No model speed measurements have yet been taken on the Samsung.

Manually check arithmetic (17×23=391), an explanation of seasons, a short Python function, English/Armenian/Russian prompts relevant to you, an ambiguous request, and a factual question whose answer you know. Compare Reasoned and Direct. Small models and abliteration can reduce quality; publisher refusal tests are not general intelligence benchmarks.

## Ephemeral data

Chats live only in browser memory and request-local gateway/inference memory. Leaving, reloading or clearing aborts the request. The server has no chat database, conversation identifiers, prompt logs or disk prompt cache. Cross-request prompt caching is disabled. The gateway erases slot 0 before and after each generation and stops accepting inference if erasure fails. Only weights and compiled software are stored.

Garbage collection/cache erasure is not secure physical RAM wiping. Operating-system state and hosting/tunnel providers have separate policies. On the supplied services application swap and core dumps are disabled; diagnostic logs contain startup/thermal status, not prompts. Do not claim anonymity or guaranteed zero infrastructure logs.
