# Offscript

A cloud-only, temporary AI chat website with the supplied anonymous logo. No accounts, chat database, analytics, cookies, localStorage, sessionStorage, or conversation archive are implemented by the app. The conversation is kept in React memory and cleared on reset, reload, page exit, and restoration from the browser's back/forward cache.

## Current status

- Website built and ready to publish on a free hosted subdomain.
- **Cloud inference is NOT connected.** `public/config.json` deliberately has `space: null`. The UI reports this honestly and sends no question to a model.
- The Hugging Face ZeroGPU backend in `cloud/huggingface` is a deployment candidate, **not GPU-tested**. An eligible account and a running Space are required before end-to-end validation.
- No local model or tunnel is required or used by this version. The earlier local model processes were stopped. Their isolated downloads remain under ignored `.runtime` and `.data` directories and are not deployed.
- No response-time or 10-user load result is claimed until the actual cloud service passes those checks.

## Development and static hosting

Node 24+:

```sh
npm ci
npm run dev
npm run build
npm run preview
npm test
```

The output is `dist/`. It can run on Sites, Cloudflare Pages, Netlify, GitHub Pages (with the correct base path), or InfinityFree's `htdocs` folder. The website itself needs no Node or Python process in production. `_headers` supplies security and cache policy on hosts that support that file; equivalent headers must be configured separately on other providers.

## Connect the model

1. Sign into a Hugging Face account eligible for free ZeroGPU hosting (currently verified and over 30 days old).
2. Create a public Gradio Space and upload the files in `cloud/huggingface/`. Select **ZeroGPU**, not a paid GPU.
3. Resolve any build/runtime compatibility issues. Test the `/generate` endpoint with a harmless question, a follow-up, a stopped request, and concurrent requests. Measure GPU memory and warm/cold latency. The quantized checkpoint and ZeroGPU runtime are not verified until this succeeds.
4. Set `space` in `public/config.json` to your `username/space-name`. This is a public identifier, never a token. Rebuild and redeploy.
5. Verify streaming and cancellation through the public website. Visitors call the public Space directly; a shared private API token is never embedded in JavaScript.

For development, `npm test` runs the backend request-validation tests. TypeScript validation runs with `npm run build`. Do not mistake these checks for GPU inference or load tests.

## Privacy scope

The website does not persist chat content. Closing it cancels the active client job on a best-effort basis. Network failures, abrupt termination, and a third-party queue may delay cancellation. Hugging Face and the website host still process traffic under their policies; this is not a promise of zero infrastructure logs, immediate physical RAM erasure, or anonymity. The supplied backend has no chat state or application prompt logging, but the hosting provider controls its queue and infrastructure.

## Performance

The frontend streams generated text, loads the inference client only when needed, serves local fonts, and has no history fetch or database work. Thinking mode is disabled in the GPU template and Brief replies are available. There is no artificial 10-user cap. GPU concurrency and the provider's free quotas determine real capacity. Ten simultaneous requests may queue; no honest zero-cost setup can promise unlimited low latency.

## Hosting options

See [HOSTING.md](HOSTING.md) for verified options and limitations. A free subdomain is a real HTTPS website address; a custom `.com` is a separate registration purchase. Google indexing is not automatic or guaranteed.

## Asset attribution

`public/anonymous-logo.png` is a lossless PNG conversion of the image supplied by the user. Its appearance is adapted with CSS, with no generated replacement. Font licenses are included in the installed Fontsource packages. Model licensing comes from the linked model repositories.
