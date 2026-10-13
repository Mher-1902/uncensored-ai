# Reviewed delivery

Source changes go through branches and pull requests. CI uses pinned Actions and Node 24.21.0, installs the lockfile, builds production files before gateway tests, checks SEO, runs tests and audits dependencies. Dependabot proposes dependency updates through PRs.

Protect `main` with required CI and PRs. The manual **Deploy reviewed backend** workflow accepts only a full commit SHA already on main. It repeats validation before entering the `production` environment. Configure that environment with an operator reviewer and allow only protected branches. For a sole operator, keep self-review permitted for the deployment environment; a second reviewer can be required when a team is available.

Current account limitation, checked October 13, 2026: GitHub returned HTTP 403 for branch protection on this private repository, requesting GitHub Pro or a public repository. Required merge gates are therefore not enforced yet. Keep the repository private and follow the PR/CI process manually until the owner chooses a supported plan. Deployment credentials and environment gates have not been configured; automated production delivery is not active.

## Deployment setup

The workflow is committed code, but remains inactive until the following operator-owned configuration exists:

| Production setting | Purpose |
| --- | --- |
| Variable `DEPLOY_HOST` | Verified private Tailscale address |
| Variable `DEPLOY_USER` | Non-root deployment account |
| Secret `DEPLOY_KNOWN_HOSTS` | Owner-verified host entry using alias `offscript-samsung` |
| Secret `DEPLOY_SSH_PRIVATE_KEY` | Dedicated forced-command deployment key |
| Secrets `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET` | Narrow Tailscale OAuth client for ephemeral CI nodes |

Limit `tag:offscript-ci` to the target's private SSH port in tailnet policy. The Action's OAuth client needs its auth-key scope and the same tag. Keep the Mac's management private key on the Mac.

This repository is private. Configure separate, read-only repository access on the server before activating delivery, with credentials outside source control and strict upstream host verification. Git prompts are disabled in deployment; missing repository access fails before services are stopped.

Install `self-host/deploy-reviewed.sh` as a root-owned executable, for example `/usr/local/libexec/offscript-deploy-reviewed`. Authorize a separate public key with `restrict,command="/usr/local/libexec/offscript-deploy-reviewed"`; preserve existing authorized keys. The entry point accepts only `deploy <40-character SHA>`, rejects dirty source, verifies main ancestry and refuses automated model/runtime changes.

Create private configuration files under `~/.config/offscript/`:

```ini
# deploy.env: used by the guarded frontend build
SITE_API_BASE=https://YOUR-VERIFIED-GATEWAY/api
```

```ini
# server.env: overrides the gateway's exact public API origin
PUBLIC_API_ORIGIN=https://YOUR-VERIFIED-GATEWAY
```

Set mode 0600 on these files. Use the returned tunnel hostname, then validate HTTPS health, CORS and streamed output. No provider secret belongs in a frontend variable.

## Deployment behavior

The entry point serializes releases, requires AC power and a cool CPU, stops serving during the update, checks out the reviewed commit and builds/tests under CPU and memory limits. It preserves ignored runtime/model files and private state. It restarts services and checks local readiness. Failure attempts to restore the previous source and rebuild it; inspect health if rollback also fails.

Model/runtime revisions require separate guarded preparation, real inference and thermal validation. CI mock tests do not establish model quality, sustained concurrency or unattended thermal stability. OS maintenance remains a separate administrator action.

The current frontend publishing workflow is separate from backend deployment. The final product name is undecided; Offscript remains a working name.
