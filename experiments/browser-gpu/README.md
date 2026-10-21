# Optional browser GPU prototype

The owner approved preparing this option on October 21, 2026. It is a standalone local research page, with no production imports, public rewrite, account/session integration or automatic model download. The live website and Samsung inference remain unchanged. There is no paid provider, trial, credit or server rental.

The current Samsung decodes around 4 tokens/second. CPU engine, layout and quantization experiments have not produced an acceptable speed win. This prototype asks whether compatible visitors can instead run the **same selected model** on their own GPU. It is not a demonstrated speedup, mobile-compatibility claim or 50,000-user capacity plan.

## Exact inputs and APIs

- Runtime: `@wllama/wllama` 3.8.1, npm gitHead `b68fd6427063266176bb0054befe9ff70b3258f1`, bundled llama.cpp `b11364-46ca246`. The package-lock records the reviewed SHA512. The default WASM is copied locally at build time; CDN compatibility loading is explicitly disabled.
- Model: HauhauCS/Qwen3.5-2B-Uncensored-HauhauCS-Aggressive, revision `2bcf35c1ebf62c837c12c1aa90b578ff4717e831`, Q4_K_M, 1,270,808,032 bytes. Whole-file SHA256 `be3ccca13a9d1bc8b67165ea80bd103cd6151a37ad131183cc7ca388f78d9517`.
- `model-manifest.json` contains ordered 16 MiB chunk digests derived from the checksum-verified Samsung serving artifact. Streaming verification checks every chunk and the exact length without allocating a second 1.3 GB hash buffer. These digests describe one file, not a newly quantized or substituted checkpoint.
- The package's `loadModelFromUrl({useCache:false})` still uses its downloader/cache. This prototype instead owns a dedicated OPFS model directory and passes only a verified `File` to `loadModel(Blob[])`.
- Generation uses `abortSignal`; `loadModel` has no abort API. Stop requests abort and calls `exit()` to terminate the worker. A late loader triggers a second teardown and blocks replacement tests until that cleanup settles. Hung/failed cleanup fails closed. Every completed run unloads its worker; subsequent tests get a fresh instance.
- Capability checks alone do not establish GPU execution. Before sending a fixed test prompt, bounded native loading logs must confirm a WebGPU backend and full positive layer offload. Wllama maps native INFO to `logger.debug`; the wrapper parses only counters during loading and discards all raw diagnostics. No CPU/server fallback is initiated if proof is absent.

## Data and user choice

Opening the page does not fetch a model or create an inference worker. Check device, model download/storage consent, download, saved-model verification and test execution are separate actions. Model-download requests contain no account credentials, cookies or chat text. Hugging Face and its CDN still see normal network metadata for those downloads.

Only the optional model binary is stored in `offscript-browser-gpu-model-v1`. Exclusive WebLocks prevent conflicting cache operations across tabs. Failed downloads abort writes, cancel unread bodies, remove new incomplete entries and preserve a previously saved model. Remove deletes only that model directory. This is separate from the deployed site's session/cookie policy: no public notice is silently changed to claim model caching has already launched.

The page runs two fixed synthetic general/coding questions. Text is rendered with `textContent`, stays in page memory and is never written to storage, logs or telemetry. Closing the prototype clears it. The page does not read live chats, auth tokens or user IDs. Switching away stops an active operation. The 128-token research cap is shown and a `length` stop is explicitly incomplete; it does not alter production reply limits.

## Local preparation on the Samsung

Use the supported Node 24 toolchain and a private fixture, not the serving checkout:

```sh
npm ci --ignore-scripts
npm test
npm run build
npm run preview
```

The preview binds only 127.0.0.1:5186. An operator can forward that port through existing private SSH. Keep production CSP/OAuth headers unchanged. The local preview has its own restrictive WASM/blob-worker CSP, COOP/COEP headers and no public model proxy. No service or auto-start unit is installed.

Build/mock checks do not execute WASM, load the model or measure a real GPU. Do not mark this mode ready or integrate it into chat until real devices pass: exact model loading, positive GPU proof, fixed-answer usefulness, TTFT/coldload/complete time, sustained memory/battery behavior, Stop during loading and generation, close/clear/fresh-worker isolation, failed downloads/cache removal, and desktop/mobile/browser compatibility. Mobile devices may not have enough memory even when WebGPU is available. Some browser errors cannot be recovered without reloading this research page.

## Primary references

- [Wllama official source and WebGPU documentation](https://github.com/ngxson/wllama)
- [Pinned runtime source](https://github.com/ngxson/wllama/tree/b68fd6427063266176bb0054befe9ff70b3258f1)
- [Selected model revision](https://huggingface.co/HauhauCS/Qwen3.5-2B-Uncensored-HauhauCS-Aggressive/tree/2bcf35c1ebf62c837c12c1aa90b578ff4717e831)

Wllama and llama.cpp use MIT licenses; preserve their notices when distributing generated runtime assets. The selected model's own license applies separately. No model or WASM binary is committed to this repository.
