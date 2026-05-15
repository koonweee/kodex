#!/usr/bin/env bash
set -euo pipefail

log_step() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

trap 'status=$?; log_step "ERROR exit=$status line=$LINENO command=$BASH_COMMAND" >&2; exit "$status"' ERR

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
script_path="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
session_name="${KODEX_PROD_SESSION:-kodex-prod}"
restart_session="${KODEX_PROD_RESTART_SESSION:-${session_name}-restart}"
endpoint="${KODEX_PROD_ENDPOINT:-http://127.0.0.1:8787}"
log_path="${KODEX_PROD_RESTART_LOG:-/tmp/kodex-prod-restart.log}"
curl_out="${KODEX_PROD_CURL_OUT:-/tmp/kodex-prod-curl.out}"
curl_err="${KODEX_PROD_CURL_ERR:-/tmp/kodex-prod-curl.err}"
prod_env_file="${KODEX_PROD_ENV_FILE:-$HOME/.kodex/production.env}"

if [[ "${KODEX_PROD_RESTART_PHASE:-}" != "child" ]]; then
  if [[ "$restart_session" == "$session_name" ]]; then
    echo "KODEX_PROD_RESTART_SESSION must differ from $session_name" >&2
    exit 1
  fi

  mkdir -p "$(dirname "$log_path")"
  : >"$log_path"

  if tmux has-session -t "$restart_session" 2>/dev/null; then
    log_step "Removing stale helper session $restart_session"
    tmux kill-session -t "$restart_session"
  fi

  child_command=$(
    printf 'env KODEX_PROD_RESTART_PHASE=child KODEX_PROD_SESSION=%q KODEX_PROD_RESTART_SESSION=%q KODEX_PROD_ENDPOINT=%q KODEX_PROD_RESTART_LOG=%q KODEX_PROD_CURL_OUT=%q KODEX_PROD_CURL_ERR=%q KODEX_PROD_ENV_FILE=%q %q' \
      "$session_name" \
      "$restart_session" \
      "$endpoint" \
      "$log_path" \
      "$curl_out" \
      "$curl_err" \
      "$prod_env_file" \
      "$script_path"
    for arg in "$@"; do
      printf ' %q' "$arg"
    done
    printf ' >>%q 2>&1' "$log_path"
  )

  tmux new-session -d -s "$restart_session" -c "$repo_root" "bash -lc $(printf '%q' "$child_command")"

  echo "Restart handed off to tmux session $restart_session."
  echo "Log: $log_path"
  echo "Endpoint: $endpoint"
  exit 0
fi

log_step "Restarting $session_name from $repo_root"
log_step "Endpoint: $endpoint"
if [[ -f "$prod_env_file" ]]; then
  log_step "Production environment: $prod_env_file"
else
  log_step "Production environment: $prod_env_file not found; using process environment only"
fi

cd "$repo_root/apps/web"
log_step "Building frontend bundle"
npm run build
log_step "Frontend build finished"

if tmux has-session -t "$session_name" 2>/dev/null; then
  log_step "Stopping existing tmux session $session_name"
  tmux kill-session -t "$session_name"
fi

log_step "Starting tmux session $session_name"
session_command=$(
  printf 'set -euo pipefail; '
  printf 'if [[ -f %q ]]; then set -a; source %q; set +a; fi; ' "$prod_env_file" "$prod_env_file"
  printf 'KODEX_FRONTEND_DIST=apps/web/dist exec cargo run -p kodex-gateway'
)
tmux new-session -d -s "$session_name" \
  -c "$repo_root" \
  "bash -lc $(printf '%q' "$session_command")"

log_step "Waiting for $endpoint"
for _ in $(seq 1 30); do
  if curl -I --max-time 2 "$endpoint" >"$curl_out" 2>"$curl_err"; then
    log_step "Endpoint is healthy"
    cat "$curl_out"
    exit 0
  fi
  sleep 1
done

log_step "Timed out waiting for $endpoint" >&2
tmux capture-pane -pt "$session_name:0.0" -S -120 >&2 || true
cat "$curl_err" >&2 || true
exit 1
