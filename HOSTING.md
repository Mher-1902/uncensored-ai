# Hosting and activation

The current public frontend uses the existing Sites project in `.openai/hosting.json` and the stable HTTPS URL https://offscript-ephemeral.sukiasyanmher7.chatgpt.site/. Keep this project ID when publishing edits. The static deployment is separate from the Fedora inference process.

Use the Sites source-open, checks/build, package, save-version and deploy workflow. Publish the built `dist` output and `.openai/hosting.json`; do not upload `.runtime`, `.data`, model weights, logs or secrets. Static unknown paths use the included `404.html` with a real 404 status. The public frontend does not need a purchased domain.

For the user-approved smaller Samsung model profile, use [Fedora setup](docs/FEDORA.md) and the [handoff README](README.md). Inspection found about 8 GB RAM. The Samsung gateway was installed and actual public HTTPS inference succeeded. This source's `public/config.json` now contains the verified API endpoint and the build permits its origin in CSP. The already-published frontend still has its earlier offline configuration: the owner requested a GitHub handoff without another deployment. The last serving-profile comparison was interrupted by connection loss, so revalidate thermals/streaming before republishing.

[Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel) provides the managed `offscript-samsung.tail8c9a09.ts.net` hostname on the [free non-commercial Personal plan](https://tailscale.com/pricing), with provider limits and beta status. The installed userspace tunnel requires the Samsung to remain awake and online and does not provide a production SLA. Named Cloudflare Tunnel is an alternative if a suitable domain is already available. Quick Tunnels are unsuitable for this SSE implementation.

The earlier Hugging Face 9B template is retained as a separately untested alternative, subject to eligibility, quotas and model verification. No free static/PHP host supplies the RAM/GPU needed to run that model by simply uploading the website.

See [Google indexing](docs/GOOGLE.md) for Search Console verification and sitemap submission. A public link is not proof of Google indexing.
