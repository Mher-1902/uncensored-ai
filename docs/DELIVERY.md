# Reviewed delivery

Source changes go through branches and pull requests. CI uses pinned Actions and Node 24.21.0, installs the lockfile, builds production files before gateway tests, checks SEO, runs tests and audits dependencies. Dependabot proposes dependency updates through PRs.

Protect `main` with required CI and PRs. The manual **Deploy reviewed backend** workflow accepts only a full commit SHA already on main. It repeats validation before entering the `production` environment. Configure that environment with an operator reviewer and allow only protected branches. For a sole operator, keep self-review permitted for the deployment environment; a second reviewer can be required when a team is available.

Current account limitation, checked October 13, 2026: GitHub returned HTTP 403 for branch protection on this private repository, requesting GitHub Pro or a public repository. Required merge gates are therefore not enforced yet. Keep the repository private and follow the PR/CI process manually until the owner chooses a supported plan. Deployment credentials and environment gates have not been configured; automated production delivery is not active.

## October 19 integration candidate

`codex/pilot-integration` preserves reviewed commit history while combining staged account source `d23180f`, the live first-answer recovery source `25c605d` and CPU profile `88dfa0f`. Review the merge resolutions, run the Samsung application/Docker/database/combined-stack checks and verify the installed migration hashes before merging its main PR. Do not replay obsolete UI releases or re-run migration 001 merely to close the stacked PR backlog.

Vercel publication and the manual Samsung workflow are separate operations. Confirm the configured production branch, Production environment and provider automation before a main merge. The integration is intended to ship with `PILOT_ACCOUNT_CONTROL` absent or `false`, the restricted runtime still NOLOGIN, and draft policies unpublished. The old backend workflow must not be dispatched as an incidental part of updating main. A later protocol-5 native rollout needs its own exact-image/cleanup checks and rollback; enabling account admission requires all gates in [ACCOUNT-CONTROL.md](ACCOUNT-CONTROL.md).

The current rollback baseline is frontend source `25c605d`, Vercel Production `9nuVEzNVxc3zc4R77FZtU1bwycbV`, native source `bc228fa`/protocol 4/image `sha256:5841855aba06095441f5b8774790c268ceaabc3000e3226a3ef3b8293805de72`, with the existing model, ingress and 1.0 CPU profile preserved. Rebuilding for Production uses its Production settings; promoting a Preview with different variables is not equivalent. Existing temporary conversation tabs must not be reloaded during validation.

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
