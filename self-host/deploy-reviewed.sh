#!/usr/bin/env bash
# Install this entry point root-owned before assigning a forced-command deploy key.
set -euo pipefail
export LC_ALL=C
export GIT_TERMINAL_PROMPT=0
umask 077

request=${SSH_ORIGINAL_COMMAND:-}
if [[ ! "$request" =~ ^deploy\ ([0-9a-f]{40})$ ]]; then
  printf 'Expected: deploy <reviewed 40-character commit SHA>\n' >&2
  exit 64
fi
target=${BASH_REMATCH[1]}
if systemctl --user is-active --quiet offscript-containers; then
  printf 'This entry point manages native services; container delivery requires its reviewed deployment workflow.\n' >&2
  exit 64
fi
repo="$HOME/uncensored-ai"
test "$(id -u)" -ne 0
test -d "$XDG_RUNTIME_DIR"
exec 9>"$XDG_RUNTIME_DIR/offscript-deploy.lock"
flock -n 9
cd "$repo"
test "$(git remote get-url origin)" = https://github.com/Mher-1902/uncensored-ai.git
test -z "$(git status --porcelain)"
git fetch --no-tags origin main
git cat-file -e "$target^{commit}"
git merge-base --is-ancestor "$target" origin/main
previous=$(git rev-parse HEAD)
# Runtime/model changes require separately guarded preparation and load validation.
git diff --exit-code "$previous" "$target" -- self-host/model.json self-host/runtimes.json self-host/prepare.py self-host/bootstrap.py
test "$(cat /sys/class/power_supply/ADP1/online)" = 1
test "$(cat /sys/class/thermal/thermal_zone2/temp)" -lt 70000
test -z "$(git status --porcelain)"
test -x .runtime/node/bin/node
test -r "$HOME/.config/offscript/deploy.env"

build() {
  systemd-run --user --wait --pipe --collect \
    --unit="offscript-release-$(git rev-parse --short=12 HEAD)-$$" \
    --property="WorkingDirectory=$repo" \
    --property=CPUQuota=80% --property=MemoryMax=4G \
    --property=MemorySwapMax=0 --property=LimitCORE=0 \
    --property="EnvironmentFile=$HOME/.config/offscript/deploy.env" \
    /usr/bin/bash -c '
      set -e
      export PATH="$PWD/.runtime/node/bin:/usr/local/bin:/usr/bin:/bin"
      npm ci
      for service in cloud/vercel-api cloud/vercel-gateway; do
        if test -f "$service/package-lock.json"; then npm ci --prefix "$service"; fi
      done
      npm run build
      npm run check:seo
      npm test
      npm audit --audit-level=high
      for service in cloud/vercel-api cloud/vercel-gateway; do
        if test -f "$service/package-lock.json"; then npm audit --prefix "$service" --audit-level=high; fi
      done
    '
}
ready() {
  for attempt in $(seq 1 60); do
    if curl --silent --fail --max-time 5 http://127.0.0.1:8080/api/health >/dev/null; then return 0; fi
    if ! systemctl --user is-active --quiet offscript-model; then return 1; fi
    sleep 3
  done
  return 1
}
rollback() {
  trap - ERR
  systemctl --user stop offscript-web offscript-model || true
  git switch --detach "$previous"
  if build; then
    systemctl --user start offscript-model offscript-web
    ready || true
  fi
  printf 'Deployment failed; restored source revision %s. Inspect service health.\n' "$previous" >&2
  exit 1
}
trap rollback ERR
systemctl --user stop offscript-web offscript-model
git switch --detach "$target"
build
systemctl --user start offscript-model offscript-web
ready
trap - ERR
printf 'Deployed reviewed revision %s; local model health is ready.\n' "$target"
