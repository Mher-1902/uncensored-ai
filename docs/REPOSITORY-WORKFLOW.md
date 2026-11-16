# Repository workflow

Keep stable, released application work on `main`. Use a small set of active branches, with a temporary feature branch only while a change is being reviewed. Merge after the applicable application, container and database checks pass; an open or archived experiment is not a release.

## Active work

| Branch | Purpose |
| --- | --- |
| `main` | Stable website and production source |
| `codex/rust-backend` | Private Rust tokenizer/backend candidate; deployment gates remain open |
| `codex/samsung-latency-runtime` | Undeployed CPU latency work; thermal validation remains open |
| `maintenance/dependency-updates` | Consolidated dependency proposals awaiting compatibility review |

Do not merge unfinished runtime experiments to reduce branch counts. Preserve the live model, request isolation and resource/thermal limits. New application fixes start from current `main` and return through a small PR.

## Cleanup and recovery

The November 15 cleanup inventories all original branch heads before deletion and verifies a complete local Git bundle. Old branches whose exact tips are ancestors of `main` can be removed without losing commits. Outdated stacked PRs are closed when their heads are already included in `main`.

Retired unmerged work is preserved with exact-tip lightweight tags under `archive/2026-11-15/`, including the original branch name after the date. This covers the browser-GPU, MNN, CPU-layout and older prefill experiments, plus the individual dependency proposals. Their historical PRs remain available. An archive tag preserves code and evidence; it does not approve or activate the experiment.

To recover an archived proposal, fetch tags and create a new working branch from its tag. Never overwrite the archive tag or reset `main` to an old experiment. Local worktrees and their uncommitted changes are preserved independently of remote branch cleanup.

The twelve dependency proposals are also retained on `maintenance/dependency-updates`, with original commit IDs in the cherry-pick messages. This review branch includes major upgrades and is deliberately separate from production. Evaluate the combined dependency constraints, build images and runtime compatibility before release.

## Preventing branch buildup

Enable GitHub's automatic deletion of merged PR branches. Dependabot's weekly version updates use one multi-ecosystem `maintenance` group for the three npm manifests, Docker and GitHub Actions, following the [official configuration](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/configuring-multi-ecosystem-updates). Security alerts and security updates remain enabled; urgent security work can temporarily exceed the ordinary active-branch target.

Do not enable automatic merging, force-push `main`, disable security updates, or transfer the repository as part of housekeeping. The repository remains `Mher-1902/uncensored-ai`.
