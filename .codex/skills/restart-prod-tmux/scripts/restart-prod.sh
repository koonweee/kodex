#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
script_path="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
session_name="${KODEX_PROD_SESSION:-kodex-prod}"
restart_session="${KODEX_PROD_RESTART_SESSION:-${session_name}-restart}"
endpoint="${KODEX_PROD_ENDPOINT:-http://127.0.0.1:8787}"
log_path="${KODEX_PROD_RESTART_LOG:-/tmp/kodex-prod-restart.log}"
curl_out="${KODEX_PROD_CURL_OUT:-/tmp/kodex-prod-curl.out}"
curl_err="${KODEX_PROD_CURL_ERR:-/tmp/kodex-prod-curl.err}"

if [[ "${KODEX_PROD_RESTART_PHASE:-}" != "child" ]]; then
  if [[ "$restart_session" == "$session_name" ]]; then
    echo "KODEX_PROD_RESTART_SESSION must differ from $session_name" >&2
    exit 1
  fi

  mkdir -p "$(dirname "$log_path")"
  : >"$log_path"

  if tmux has-session -t "$restart_session" 2>/dev/null; then
    tmux kill-session -t "$restart_session"
  fi

  child_command=$(
    printf 'env KODEX_PROD_RESTART_PHASE=child KODEX_PROD_SESSION=%q KODEX_PROD_RESTART_SESSION=%q KODEX_PROD_ENDPOINT=%q KODEX_PROD_RESTART_LOG=%q KODEX_PROD_CURL_OUT=%q KODEX_PROD_CURL_ERR=%q %q' \
      "$session_name" \
      "$restart_session" \
      "$endpoint" \
      "$log_path" \
      "$curl_out" \
      "$curl_err" \
      "$script_path"
    for arg in "$@"; do
      printf ' %q' "$arg"
    done
    printf ' >>%q 2>&1' "$log_path"
  )

  tmux new-session -d -s "$restart_session" -c "$repo_root" "$child_command"

  echo "Restart handed off to tmux session $restart_session."
  echo "Log: $log_path"
  echo "Endpoint: $endpoint"
  exit 0
fi

echo "Restarting $session_name from $repo_root"
echo "Endpoint: $endpoint"

cd "$repo_root/apps/web"
npm run build

if tmux has-session -t "$session_name" 2>/dev/null; then
  tmux kill-session -t "$session_name"
fi

tmux new-session -d -s "$session_name" \
  -c "$repo_root" \
  "KODEX_FRONTEND_DIST=apps/web/dist cargo run -p kodex-gateway"

for _ in $(seq 1 30); do
  if curl -I --max-time 2 "$endpoint" >"$curl_out" 2>"$curl_err"; then
    cat "$curl_out"
    exit 0
  fi
  sleep 1
done

echo "Timed out waiting for $endpoint" >&2
tmux capture-pane -pt "$session_name:0.0" -S -120 >&2 || true
cat "$curl_err" >&2 || true
exit 1
