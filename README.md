# Offscript

An ephemeral AI chat website with the supplied anonymous logo. No accounts, chat database, browser history storage or analytics. Messages remain in page/request memory and are cleared on leaving or reloading.

Public website: **https://offscript-ephemeral.sukiasyanmher7.chatgpt.site/**

**Current activation status:** the frontend can be published independently. Its `public/config.json` deliberately contains `apiBase: null`; real replies remain unavailable until the Fedora model server is connected and verified. The UI reports this honestly.

## Selected Samsung profile

For the Samsung Series 9, Fedora, Sandy Bridge i5, 4 GB RAM: **Huihui Qwen3 1.7B abliterated v2, Q4_K_M GGUF**, 1.11 GB, pinned revision and SHA-256. The user approved a smaller model after the requested Qwen3.5 9B's 5.63 GB weights exceeded the laptop's RAM. This profile uses llama.cpp, not AWQ/vLLM. No Samsung inference benchmark or quality guarantee is claimed.

See [Fedora setup](docs/FEDORA.md), [latency research](docs/LATENCY-RESEARCH.md), and [Google indexing](docs/GOOGLE.md).

## Develop and check

Node.js 24+, Python 3, npm:

```sh
npm ci
npm run dev
npm run build
npm test
```

Build generates crawlable homepage HTML, hydrates the React UI, defers Markdown formatting until needed, and emits a sitemap plus custom 404. The Sites static manifest returns real 404s instead of serving the homepage for every URL. The gateway is a separate Node service, not deployed inside this static frontend.

## Run inference on Fedora

```sh
npm run fedora:inspect
npm run fedora:prepare
npm run fedora:model
```

In another terminal:

```sh
npm start
npm run benchmark
```

Read `docs/FEDORA.md` before public activation. `self-host/` includes CPU-feature-aware compilation, verified model download, real-memory startup checks, thermal monitoring and optional systemd resource limits. The loopback gateway validates conversation structure, counts exact model tokens, streams answers, aborts on disconnect, serializes generation and erases prompt cache after requests. It never saves conversations or exposes llama.cpp administration endpoints.

The public website remains on the hosted HTTPS subdomain. Once the laptop has a verified public HTTPS gateway, `node scripts/connect-model.mjs https://THE-REAL-HOST/api` checks health/CORS and saves the endpoint. Rebuild and publish to activate it; CSP allows only the configured API origin. Leave credentials out of frontend configuration.

## Privacy and practical limits

There is no application chat retention. Cache erasure/garbage collection is not physical RAM wiping. OS and hosting/tunnel infrastructure have their own behavior and policies. Reasoned mode is the default; Direct mode is an explicit speed/quality choice. Context/output/queue limits protect the old laptop and produce clear errors. Ten callers may queue; ten simultaneous fast generations are not promised.

`cloud/huggingface/` is the earlier, unverified 9B GPU hosting alternative. It is not the current model connection or Samsung setup. No cloud GPU deployment, Fedora service install, tunnel setup or Google indexing request is represented as completed.
