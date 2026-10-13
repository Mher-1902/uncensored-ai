# Offscript — project handoff

For ongoing changes, use the [reviewed delivery workflow](docs/DELIVERY.md), [security requirements](SECURITY.md) and [infrastructure roadmap](docs/ROADMAP.md). The handoff below records the earlier machine state; current deployments require fresh validation.

The [Docker backend](docs/DOCKER.md) runs on the Samsung independently of the Mac. Docker Desktop is optional tooling; server development and serving stay on the Samsung.

Offscript is an ephemeral AI chat website with the supplied anonymous figure/logo, a charcoal-and-lime visual theme, expressive typography, streaming replies, a custom 404 page and search-engine metadata. Conversations stay in the current browser page and request memory; there is no account system, chat database, saved conversation history or analytics.

**Handoff checkpoint: October 4, 2026.** The owner asked us to stop development, document the work and push everything to GitHub before retiring the development Mac. This README is the starting point for the next laptop or Codex session. Do not assume the public frontend has already received the latest model connection.

## Start here: exact state at handoff

| Item | Verified state |
| --- | --- |
| Source repository | [Mher-1902/uncensored-ai](https://github.com/Mher-1902/uncensored-ai), branch `main` |
| Website/product name | **Offscript** |
| Existing hosted frontend | [offscript-ephemeral.sukiasyanmher7.chatgpt.site](https://offscript-ephemeral.sukiasyanmher7.chatgpt.site/) |
| Samsung public HTTPS gateway | `https://offscript-samsung.tail8c9a09.ts.net` — enabled and tested with actual streamed model output earlier in this session |
| API endpoint in this source | `https://offscript-samsung.tail8c9a09.ts.net/api` |
| Selected model | Huihui Qwen3 1.7B abliterated v2, importance-matrix Q4_K_M GGUF |
| Last published frontend source | Commit `a18398e9a03d2d2daba7a988f51ba4c9b602c45a`; that release has `apiBase: null` and reports the model offline |
| Latest source/build | Connected API configuration, updated CSP, Samsung services and setup fixes are included here; production build and SEO checks passed |
| Latest automated checks | Four Python tests and ten Node gateway tests passed |
| Deployment of this handoff | **Not performed**, at the owner's request to stop and push only |
| Google Search | SEO files exist; Search Console verification, sitemap submission and indexing are **not completed** |
| Samsung at the end | SSH timed out and the last public benchmark ended with a closed connection. Current availability cannot be confirmed. It must be awake and connected for replies |

The static website can stay online when the Samsung is off, but AI replies cannot. During testing the Samsung's HTTPS root also served the website directly, using its local gateway and `/api`; that route depends entirely on the laptop being online. Visitors do not need a Tailscale account.

## What was built and why

The frontend uses React, TypeScript and Vite. The initial viewport centers the Offscript brand, the supplied anonymous visual and the message composer. It supports desktop and mobile, keyboard submission, selectable reply length, explicit Reasoned/Direct modes, stopping a response and clearing the current conversation. Markdown formatting loads only when needed, reducing initial JavaScript from about 123 KB to **76.69 KB gzip**. Motion follows the established design without adding dashboard clutter.

The production build renders real homepage HTML before React hydrates. It includes a canonical URL, page title/description, Open Graph/Twitter metadata, a homepage-only `sitemap.xml`, `robots.txt`, asset preloads and a branded 404 with `noindex`. Unknown addresses return an actual HTTP 404. Operational/API/configuration URLs stay out of search indexes. See [Google setup](docs/GOOGLE.md).

The model runs in a separate CPU-only llama.cpp process. A small Node gateway validates incoming conversations, counts tokens using the actual template/tokenizer, streams SSE, queues requests and clears the inference slot. Tailscale Funnel forwards public HTTPS to this gateway. The model's administrative port remains bound to loopback and is not forwarded publicly.

The separation keeps heavy inference off the static website host and avoids needing to purchase a domain. Tailscale's free Personal plan is intended for personal, non-commercial use; Funnel is beta and has provider limits. This setup does not provide a production uptime SLA or unlimited compute. The existing Sites frontend uses its existing managed subdomain and project; it is not hosted on InfinityFree.

## The actual Samsung we inspected

The owner originally described a 2011 Samsung Series 9 with an i5, 4 GB RAM and 128 GB SSD. SSH inspection showed different hardware. Use the measured values below when making decisions; the exact chassis model number was not independently confirmed.

| Property | Measured value |
| --- | --- |
| Account / hostname | `rog` / `fedora` |
| Operating system | Fedora 42, x86_64 |
| CPU | Intel Core i7-3517U @ 1.90 GHz |
| CPU topology | Two physical cores, four logical threads |
| CPU features | AVX, F16C and SSE4.2 available; AVX2, FMA and BMI2 unavailable |
| Physical memory | **7,554 MiB**, approximately 8 GB installed |
| Initially available memory | Roughly 3.6–4.4 GiB, varying with desktop apps |
| Existing swap | zram; roughly 1.2 GiB already occupied before inference testing |
| Root filesystem | Approximately 237 GiB, with about 211 GiB free at inspection |
| Initial temperature | Approximately 57–60°C |
| Project location | `/home/rog/uncensored-ai` |
| Last-known private LAN address | `10.27.65.190`; it may change and requires a reachable network |
| Codex CLI on Samsung | `0.160.0`, available as `/usr/lib/chatgpt/resources/codex`; login was verified earlier |
| System Node | 22.21.1, too old for this project |
| Project-local Node | Official Node **24.21.0** |
| Project-local Tailscale | Official Tailscale **1.102.4** |

No broad cleanup, disk wipe, Fedora reinstall or deletion of the owner's files was performed. The desktop and account remain. Existing OS swap was not disabled globally; the supplied application services have no swap allowance.

## Model choice and compatibility fixes

The owner approved a smaller abliterated model after the requested Qwen3.5 9B Q4 weights exceeded the originally reported 4 GB memory. Although the real machine has more RAM, its old CPU, occupied desktop memory and observed heat still favor the smaller model. This is a practical compromise; it is not a claim that the derivative is objectively the best model or that abliteration preserves all reasoning quality.

We use [Huihui Qwen3 1.7B abliterated v2](https://huggingface.co/huihui-ai/Huihui-Qwen3-1.7B-abliterated-v2), quantized by [mradermacher](https://huggingface.co/mradermacher/Huihui-Qwen3-1.7B-abliterated-v2-i1-GGUF):

- File: `Huihui-Qwen3-1.7B-abliterated-v2.i1-Q4_K_M.gguf`.
- Size: **1,107,405,664 bytes**, about 1.03 GiB.
- Model repository revision: `aff5de9e25c8ab0d4dcf7da82aca0adbdac3ae98`.
- Model SHA-256: `578d94267903dc808e476ba8f94f65e5cd8cca29d9a1110b65407d76c56689ac`.
- llama.cpp revision: `0504396140d1c882f5f6ee34466a42db7ae90114`.

These values are pinned in [self-host/model.json](self-host/model.json). GGUF uses llama.cpp here; it is not AWQ. AWQ/vLLM acceleration assumptions do not match this old CPU-only laptop and its integrated graphics.

Compilation detects the real CPU flags instead of assuming AVX2/FMA/BMI2 support. It disables CUDA/Vulkan/BLAS, uses one compile worker and disables llama.cpp's curl integration because weights are downloaded and verified by Python. This avoids requiring missing libcurl development headers. During the initial higher-load setup temperature reached **91°C**; compilation was stopped and replaced with an 80% CPU-limited build that pauses at 80°C and resumes at 70°C. The resulting binary ran successfully on the Samsung.

Two issues were found by actual inference, after mock gateway tests had passed:

1. This llama.cpp revision rejects slot erasure without `--slot-save-path`. We enabled the flag with a private directory under `/run/user/1000/offscript-model`, verified that Fedora backs that directory with **tmpfs**, and allowed only the erase action through internal gateway code. The gateway never invokes slot save/restore. Public requests to model administration paths returned 404.
2. The selected GGUF embeds a simplified ChatML template without Qwen's thinking switch. A supposed Direct reply used the entire 256-token budget thinking. We replaced that template with the **unmodified official Qwen3-1.7B template**, pinned and checksum-verified at startup. Provenance and Apache license are in [self-host/TEMPLATE-NOTICE.md](self-host/TEMPLATE-NOTICE.md). Afterwards Direct mode returned `391` for `17 × 23`, with a complete stream and no thinking output.

The default UI remains **Reasoned**. Direct is an explicit user choice for quicker answers and potentially weaker reasoning. The weights have not been distilled, pruned or changed during performance tuning. Reasoned-mode answer quality and sustained public concurrency have not yet been verified on this machine.

## How the Samsung behaved in testing

These measurements were taken through the real public HTTPS API, with one client and a fixed synthetic prompt asking for three short sentences explaining Earth's seasons. Each completed benchmark had one initial request followed by **five warm samples**. Output lengths vary with sampling, so throughput is useful alongside total time. This is a small sample, not a reliable p95 or uptime certification.

| Profile | Median first answer | Median complete reply | Median decode rate | Thermal result |
| --- | ---: | ---: | ---: | --- |
| Two threads, CPUQuota 100% | **3.40 s** | **20.63 s** | **4.58 tokens/s** | Completed; monitor observed up to 81°C |
| One thread, CPUQuota 100% | Not established | Not established | Not established | Reached 85°C; guard stopped the model |
| One thread, CPUQuota 80% | **3.90 s** | **21.10 s** | **4.12 tokens/s** | Completed; one-second sampling observed up to 83°C |
| **Current: two threads, CPUQuota 80%** | **Not established** | **Not established** | **Not established** | Observed up to 77°C before connection loss; final benchmark did not finish |

The corrected Direct arithmetic test completed in about **4.94 seconds**, with its first answer at **4.25 seconds**. That test used the earlier two-thread/100% profile and is not a measurement of the current profile.

During the one-thread/80% run the llama-server process showed approximately **1.57 GiB RSS**, about 3.8 GiB remained available system-wide, and the model cgroup reported **zero application swap**. Cgroup memory readings were lower than RSS because previously loaded shared/file-backed pages have different accounting; do not confuse those numbers with total model memory requirements.

The current profile retains two threads and **CPUQuota 80%** to reduce heat. The comparison was interrupted by a closed public connection and subsequent SSH timeout. We did not diagnose the disconnect or repeat the benchmark after the owner requested a stop. It must be revalidated after the laptop is awake again. There is no crash-proof guarantee and no claim that ten users receive simultaneous fast generations.

On the Samsung itself, dependency installation, the frontend production build, SEO checks and the then-existing **13 tests** passed using project-local Node 24. The final gateway-origin regression added one more test; all **14 tests** passed on the development Mac. The newest test suite could not be rerun on the disconnected Samsung before handoff.

## Current runtime layout and protections

| Component | Location / behavior |
| --- | --- |
| Model weights | `~/uncensored-ai/.data/models/` |
| llama.cpp source/build | `~/uncensored-ai/.runtime/llama.cpp/` |
| Node binary | `~/uncensored-ai/.runtime/node/bin/node` |
| Tailscale binaries | `~/uncensored-ai/.runtime/tailscale/` |
| User service definitions | `~/.config/systemd/user/offscript-{model,web,tunnel}.service` |
| Private Tailscale state | `~/.local/state/offscript/tailscale/`, mode 0700; contains credentials |
| Tailscale socket | `$XDG_RUNTIME_DIR/offscript-tailscale/tailscaled.sock` |
| Model listener | `127.0.0.1:8081` |
| Gateway listener | `127.0.0.1:8080` |
| Public forwarding | Tailscale Funnel HTTPS → gateway port 8080 |

The model uses one slot, 4,096 total context tokens, 128-token logical prefill batches, 64-token microbatches and F16 KV cache. The gateway counts actual templated tokens and reserves output/thinking room. Oversized conversations get an error rather than silently losing turns.

The model service has a 2,200 MiB memory soft threshold, 2,500 MiB hard limit, zero swap allowance, reduced scheduling priority, CPUQuota 80% and no automatic restart after thermal shutdown. The gateway and tunnel each have a 256 MiB memory limit and no swap allowance. Core dumps are disabled. The model stops at 85°C; the gateway checks temperatures while answering. CPU/fan/firmware thermal protections have not been disabled.

One inference slot serializes requests. The bounded queue accepts up to 32 waiting requests with five-minute queue/generation deadlines. Ten serialized callers passed **mock** integration tests; an actual ten-client public load test is still outstanding. Long Reasoned replies can take minutes or exceed a timeout on this CPU.

User services were installed and started, but automatic startup at login was not enabled. `Linger=no` was verified. A sleep-inhibitor permission test required interactive authentication, so no sleep inhibitor or power change was installed. The desktop's AC idle-sleep timeout was **7,200 seconds** at inspection. Closing the lid, suspending, shutting down, full logout or losing connectivity may stop replies. Keep it awake, connected and ventilated during initial resumption; unattended operation needs a separate decision after cooling assessment.

## Resume on the same Samsung

Use a terminal or Codex directly on Fedora. The existing model, compiled binary and Tailscale credentials should still be there; they are intentionally not in GitHub.

```sh
cd ~/uncensored-ai
git status --short
```

**The Samsung still has uncommitted setup files copied during this session.** Its final synchronization could not be performed because SSH stopped responding. Preserve these changes before pulling; do not run a destructive reset:

```sh
git stash push --include-untracked -m 'Preserve Samsung setup before handoff update'
git pull --ff-only origin main
```

Ignored `.runtime` and `.data` directories are not removed by this stash command. Keep the stash as a backup. The pushed source contains the intended final setup; inspect `git stash show --stat --include-untracked` before deciding whether to restore any different local work.

Then use the project-local runtime and verify prerequisites:

```sh
python3 self-host/bootstrap.py
export PATH="$PWD/.runtime/node/bin:$PATH"
node --version
npm ci
npm run fedora:inspect
npm run build
npm run check:seo
npm test
```

If weights or the binary are missing, preparation reuses checksum-verified weights but still checks/configures the pinned compiler source. Let the laptop cool first. Build, tests and inference should not all run at once on this old machine. The exact guarded build approach used on the Samsung is:

```sh
systemd-run --user --unit=offscript-prepare --collect \
  --property="WorkingDirectory=$PWD" \
  --property=CPUQuota=80% --property=MemoryHigh=1800M \
  --property=MemoryMax=2500M --property=MemorySwapMax=0 \
  --property=Nice=10 --property=LimitCORE=0 \
  /usr/bin/env PATH="$PWD/.runtime/node/bin:/usr/local/bin:/usr/bin:/bin" \
  /usr/bin/python3 "$PWD/self-host/prepare.py"
journalctl --user -u offscript-prepare -f
```

Stopping the journal viewer does not stop compilation. To stop this build deliberately, use `systemctl --user stop offscript-prepare`. Check the journal and `.runtime/llama.cpp/build/bin/llama-server --version` after completion. The transient build unit can disappear after finishing; the log remains. The plain `npm run fedora:prepare` command has the thermal pause guard but not these systemd CPU/memory limits.

Install the final service files and start the existing tunnel first:

```sh
install -d -m 700 ~/.local/state/offscript/tailscale
mkdir -p ~/.config/systemd/user
cp self-host/offscript-model.service self-host/offscript-web.service self-host/offscript-tunnel.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user start offscript-tunnel
.runtime/tailscale/tailscale --socket="$XDG_RUNTIME_DIR/offscript-tailscale/tailscaled.sock" status
```

The owner already signed in and enabled Funnel for `offscript-samsung`. If the existing private state is intact, do not create another account/device or copy old sign-in URLs. If it needs authentication, follow the fresh URL printed by:

```sh
.runtime/tailscale/tailscale --socket="$XDG_RUNTIME_DIR/offscript-tailscale/tailscaled.sock" up --hostname=offscript-samsung --accept-dns=false
```

Confirm or restore the forwarding rule, then start inference:

```sh
.runtime/tailscale/tailscale --socket="$XDG_RUNTIME_DIR/offscript-tailscale/tailscaled.sock" funnel --bg http://127.0.0.1:8080
systemctl --user start offscript-model offscript-web
systemctl --user status offscript-model offscript-web offscript-tunnel
curl --max-time 10 http://127.0.0.1:8080/api/health
curl --max-time 20 https://offscript-samsung.tail8c9a09.ts.net/api/health
```

Readiness may initially be false while the model loads. If startup failed, inspect startup/thermal diagnostics without enabling prompt logs:

```sh
journalctl --user -u offscript-model -u offscript-web -u offscript-tunnel -n 60 --no-pager
npm run fedora:inspect
```

After a thermal stop, cool and inspect the laptop, then restart **both** model and web gateway. Restarting the gateway resets its fail-closed cache-cleanup state:

```sh
systemctl --user restart offscript-model offscript-web
```

Do not remove the thermal guard or increase limits to hide failures.

## Connect from a new laptop

This Mac is not required to serve Offscript. The Samsung holds its own runtime and tunnel state. A new development laptop can clone the GitHub source and reconnect independently:

```sh
git clone https://github.com/Mher-1902/uncensored-ai.git
cd uncensored-ai
```

For remote SSH, create a **new** key on the new laptop and install its public key into `rog`'s `authorized_keys` using the Samsung password locally. Do not reuse or put the retired Mac's private key in GitHub:

```sh
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_samsung_codex
ssh-copy-id -i ~/.ssh/id_ed25519_samsung_codex.pub rog@10.27.65.190
ssh -i ~/.ssh/id_ed25519_samsung_codex rog@10.27.65.190
```

These commands assume a reachable LAN and an unchanged address; check `hostname -I` on the Samsung if necessary. `ssh-copy-id` may need installation on the new OS. The previously accepted Samsung ED25519 host fingerprint was `SHA256:tUhqPuAEXQtL2RL/F9uAjvIP8mIJuBTCc1wiffUJCO8`; verify it on the Samsung before accepting an unexpected key.

You can also open `~/uncensored-ai` directly in Codex on the Samsung. Its Codex installation was authenticated earlier. A new machine needs its own Codex sign-in and GitHub authorization; neither is supplied by cloning a repository. The old Mac's SSH key was never uploaded to the Samsung as a private key or committed.

## Remaining work — only after resuming

1. Bring the Samsung back online and synchronize its source using the preservation steps above.
2. Confirm the current **two-thread/80%** profile produces complete public streams without a thermal stop. Complete the interrupted benchmark, test Reasoned answers, real cancellation/cache cleanup and a small concurrent burst while watching memory and temperatures.
3. Confirm a real browser can chat through HTTPS. Browser loading and MODEL ONLINE were observed on the Samsung preview; sending a browser prompt through the final profile was not completed.
4. Recheck the endpoint from the website development checkout:

   ```sh
   node scripts/connect-model.mjs https://offscript-samsung.tail8c9a09.ts.net/api
   npm run build
   npm run check:seo
   npm test
   ```

5. Publish the latest built frontend using the **existing Sites project**, retaining `.openai/hosting.json`, its audience and existing domain. Use the installed Sites skill's source-open → build/package → save-version → deploy workflow. A GitHub push alone does not deploy this managed Site. Do not create a replacement site or invent a deployment URL.
6. If desired, finish Google Search Console's URL-prefix verification and sitemap submission using the owner's actual verification token. A public URL does not guarantee Google indexing.
7. Decide separately how to keep the server awake and start services after login/reboot. We did not enable lingering, automatic login, sleep inhibition or service auto-start, and did not perform an unattended longevity test.

A suggested prompt for the next Codex session:

> Read README.md and docs/FEDORA.md first. Resume Offscript from the October 4, 2026 handoff. Preserve the Samsung's uncommitted setup before pulling GitHub. Revalidate the two-thread/80% CPU profile, public HTTPS streaming and heat before publishing the already-prepared frontend connection to the existing Sites project. Keep chats ephemeral, preserve the official pinned Qwen template and thermal guards, and report measured latency honestly. Do not wipe files or change power settings without resolving their actual requirements.

## Reproduce on a fresh Fedora machine

The current services expect the repository at `~/uncensored-ai`. For a different Linux x86_64 server, re-inspect its hardware and update hostname/origin settings to actual verified values. The selected build flags and limits are intentionally conservative for the Samsung.

```sh
sudo dnf install git cmake gcc-c++ make python3
git clone https://github.com/Mher-1902/uncensored-ai.git
cd uncensored-ai
python3 self-host/bootstrap.py
export PATH="$PWD/.runtime/node/bin:$PATH"
npm ci
npm run fedora:inspect
npm run build
npm test
npm run fedora:prepare
```

Preparation requires at least 3,500 MiB physical RAM and 2,150 MiB currently available. Swap does not count as RAM. Bootstrap downloads official Node/Tailscale archives and checks pinned SHA-256 values before extracting. `fedora:prepare` downloads the pinned model and verifies its size/hash. No credentials are needed for the public model/source downloads. Follow [Fedora setup](docs/FEDORA.md) for starting services and public HTTPS; a fresh machine needs its own Tailscale authentication.

## Privacy boundaries and what GitHub contains

Messages exist in browser page/request memory. Reloading, leaving or clearing aborts and clears the current conversation. The gateway disables cross-request prompt caching and erases slot 0 before and after a generation; it rejects further inference if cleanup fails. Application logs contain startup/thermal status, not prompts. There is no conversation archive, database or disk prompt cache.

This does not guarantee physical RAM wiping, anonymity or zero infrastructure logs. OS, browser, network and hosting/tunnel providers have their own behavior. A small abliterated model can make mistakes; the model has no live web access.

GitHub contains the complete application source, supplied visual assets, public API configuration, pinned dependency lockfile, model/template/runtime manifests, template license, service definitions, tests and documentation. It intentionally excludes downloaded model weights, compiled runtimes, `node_modules`, generated `dist`, environment secrets, SSH private keys and Tailscale credentials. Those excluded downloads are reproducible from the pinned setup scripts; credentials must stay private. **Do not delete the Samsung's private Tailscale state when resuming.**

## Useful project files

| File | Purpose |
| --- | --- |
| `src/App.tsx`, `src/style.css` | Chat interface and visual theme |
| `src/api.ts`, `src/stream.ts` | Browser request/stream handling |
| `server/index.mjs` | Loopback gateway, exact origins, queue, validation and slot cleanup |
| `public/config.json` | Prepared public model connection; no secret |
| `scripts/build.mjs` | Production HTML, SEO output and configured API CSP |
| `scripts/connect-model.mjs` | Health/CORS check before updating API configuration |
| `scripts/benchmark.mjs` | Synthetic aggregate latency benchmark; no visitor chat recording |
| `self-host/bootstrap.py`, `runtimes.json` | Official pinned project-local Node/Tailscale binaries |
| `self-host/prepare.py`, `model.json` | CPU-aware compilation and verified model download |
| `self-host/run_model.py`, `thermal.mjs` | Integrity checks, private tmpfs slot path and thermal protection |
| `self-host/offscript-*.service` | Fedora user model, gateway and userspace tunnel services |
| `docs/FEDORA.md` | Additional server operation details |
| `docs/LATENCY-RESEARCH.md` | Primary-source inference rationale and research references |
| `docs/GOOGLE.md` | Metadata, sitemap and remaining Search Console steps |
| `HOSTING.md`, `.openai/hosting.json` | Existing frontend hosting identity and deployment requirements |
| `cloud/huggingface/` | Historical, unverified 9B GPU-hosting alternative; not the active Samsung setup |
