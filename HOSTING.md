# Hosting and activation

The current public frontend uses the existing Sites project in `.openai/hosting.json` and the stable HTTPS URL https://offscript-ephemeral.sukiasyanmher7.chatgpt.site/. Keep this project ID when publishing edits. The static deployment is separate from the Fedora inference process.

Use the Sites source-open, checks/build, package, save-version and deploy workflow. Publish the built `dist` output and `.openai/hosting.json`; do not upload `.runtime`, `.data`, model weights, logs or secrets. Static unknown paths use the included `404.html` with a real 404 status. The public frontend does not need a purchased domain.

For the user-approved 4 GB Samsung model profile, use [Fedora setup](docs/FEDORA.md). A public HTTPS API is activated only after actual model health, end-to-end streaming, cancellation, memory and thermal checks pass. `public/config.json` is intentionally offline until then.

[Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel) provides a managed `ts.net` hostname on the [free non-commercial Personal plan](https://tailscale.com/pricing), with provider limits and beta status. This is a feasible personal route, not an installed tunnel or a production SLA. Named Cloudflare Tunnel is an alternative if a suitable domain is already available. Quick Tunnels are unsuitable for this SSE implementation.

The earlier Hugging Face 9B template is retained as a separately untested alternative, subject to eligibility, quotas and model verification. No free static/PHP host supplies the RAM/GPU needed to run that model by simply uploading the website.

See [Google indexing](docs/GOOGLE.md) for Search Console verification and sitemap submission. A public link is not proof of Google indexing.
