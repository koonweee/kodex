#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
session_name="${KODEX_PROD_SESSION:-kodex-prod}"
endpoint="${KODEX_PROD_ENDPOINT:-http://127.0.0.1:8787}"

cd "$repo_root/apps/web"
npm run build

if tmux has-session -t "$session_name" 2>/dev/null; then
  tmux kill-session -t "$session_name"
fi

tmux new-session -d -s "$session_name" \
  "cd $repo_root && KODEX_FRONTEND_DIST=apps/web/dist cargo run -p kodex-gateway"

for _ in $(seq 1 30); do
  if curl -I --max-time 2 "$endpoint" >/tmp/kodex-prod-curl.out 2>/tmp/kodex-prod-curl.err; then
    cat /tmp/kodex-prod-curl.out
    exit 0
  fi
  sleep 1
done

echo "Timed out waiting for $endpoint" >&2
tmux capture-pane -pt "$session_name:0.0" -S -120 >&2 || true
cat /tmp/kodex-prod-curl.err >&2 || true
exit 1
