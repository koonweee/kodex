#!/usr/bin/env bash
set -euo pipefail

gateway_url="${KODEX_GATEWAY_URL:-http://127.0.0.1:8787}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

api() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  if [[ -n "$body" ]]; then
    curl --fail --silent --show-error \
      -X "$method" \
      -H 'content-type: application/json' \
      -H 'accept: application/json' \
      --data "$body" \
      "${gateway_url%/}${path}"
  else
    curl --fail --silent --show-error \
      -X "$method" \
      -H 'accept: application/json' \
      "${gateway_url%/}${path}"
  fi
}

first_thread_with_older_cursor() {
  local sidebar_json thread_id detail cursor
  sidebar_json="$(api GET /v1/sidebar/threads)"
  while IFS= read -r thread_id; do
    [[ -z "$thread_id" ]] && continue
    detail="$(api GET "/v1/threads/${thread_id}" || true)"
    cursor="$(printf '%s' "$detail" | jq -r '.historyPage.olderCursor // empty' 2>/dev/null || true)"
    if [[ -n "$cursor" ]]; then
      jq -nc --arg threadId "$thread_id" --arg cursor "$cursor" '{threadId:$threadId,cursor:$cursor}'
      return 0
    fi
  done < <(printf '%s' "$sidebar_json" | jq -r '[.pinnedThreads.threads[]?.id, .chatThreads.threads[]?.id, .projectThreads[]?.threads[]?.id] | unique | .[:40][]')
  return 1
}

if ! command -v jq >/dev/null 2>&1; then
  printf 'skip: jq is required for live gateway scenario checks\n' >&2
  exit 77
fi

if ! api GET /healthz >/dev/null; then
  printf 'skip: gateway is not reachable at %s\n' "$gateway_url" >&2
  exit 77
fi

ready_json="$(api GET /readyz || true)"
if ! printf '%s' "$ready_json" | jq -e '.ready == true' >/dev/null; then
  printf 'skip: gateway is reachable but app-server is not ready: %s\n' "$ready_json" >&2
  exit 77
fi

account_json="$(api GET /v1/account)"
if printf '%s' "$account_json" | jq -e '.requiresOpenaiAuth == true and (.account == null)' >/dev/null; then
  printf 'skip: OpenAI auth is required before live iOS E2E scenarios can run\n' >&2
  exit 77
fi

project_id="$(api GET /v1/projects | jq -r --arg cwd "$repo_root" '.projects[] | select(.cwd == $cwd) | .id' | head -n 1)"
if [[ -z "$project_id" ]]; then
  project_body="$(jq -nc --arg cwd "$repo_root" --arg name "kodex-ios-e2e" '{cwd:$cwd,name:$name,createDirectory:false}')"
  project_id="$(api POST /v1/projects "$project_body" | jq -r '.id')"
fi

project_thread_id="$(api POST /v1/threads "$(jq -nc --arg projectId "$project_id" '{projectId:$projectId}')" | jq -r '.thread.id')"
chat_thread_id="$(api POST /v1/chats/threads '{"firstMessageText":"Kodex iOS API scenario"}' | jq -r '.thread.id')"

api GET /v1/sidebar/threads | jq -e '.projects and .projectThreads and .chatThreads and .pinnedThreads' >/dev/null
detail_json="$(api GET "/v1/threads/${project_thread_id}")"
printf '%s' "$detail_json" | jq -e '.thread.id and .timeline.rows' >/dev/null
older_cursor="$(printf '%s' "$detail_json" | jq -r '.historyPage.olderCursor // empty')"
if [[ -n "$older_cursor" ]]; then
  encoded_cursor="$(jq -nr --arg value "$older_cursor" '$value|@uri')"
  api GET "/v1/threads/${project_thread_id}/timeline/pages?cursor=${encoded_cursor}&limit=1" | jq -e '.thread.id and .historyPage' >/dev/null
elif older_candidate="$(first_thread_with_older_cursor)"; then
  older_thread_id="$(printf '%s' "$older_candidate" | jq -r '.threadId')"
  older_cursor="$(printf '%s' "$older_candidate" | jq -r '.cursor')"
  encoded_cursor="$(jq -nr --arg value "$older_cursor" '$value|@uri')"
  api GET "/v1/threads/${older_thread_id}/timeline/pages?cursor=${encoded_cursor}&limit=1" | jq -e '.thread.id and .historyPage and .timeline.rows' >/dev/null
else
  printf 'note: older timeline scenario skipped; no visible thread exposed an older cursor\n' >&2
fi

api POST "/v1/threads/${project_thread_id}/seen" '{"seenCompletedAgentTurnSeq":null}' >/dev/null
api POST "/v1/threads/${project_thread_id}/pin" >/dev/null
api GET /v1/sidebar/threads | jq -e --arg id "$project_thread_id" '[.pinnedThreads.threads[]?.id] | index($id) != null' >/dev/null
api DELETE "/v1/threads/${project_thread_id}/pin" >/dev/null
api GET /v1/sidebar/threads | jq -e --arg id "$project_thread_id" '[.pinnedThreads.threads[]?.id] | index($id) == null' >/dev/null
api PATCH "/v1/threads/${project_thread_id}/notifications" '{"enabled":false}' >/dev/null
api GET "/v1/threads/${project_thread_id}" | jq -e '.thread.notificationsEnabled == false' >/dev/null
api PATCH "/v1/threads/${project_thread_id}/notifications" '{"enabled":true}' >/dev/null
api GET "/v1/threads/${project_thread_id}" | jq -e '.thread.notificationsEnabled == true' >/dev/null
api PATCH "/v1/threads/${project_thread_id}/name" '{"name":"Kodex iOS API scenario"}' >/dev/null
api GET "/v1/threads/${project_thread_id}" | jq -e '.thread.name == "Kodex iOS API scenario"' >/dev/null

tmp_png="$(mktemp "${TMPDIR:-/tmp}/kodex-ios-e2e.XXXXXX.png")"
trap 'rm -f "$tmp_png"' EXIT
base64 --decode > "$tmp_png" <<'PNG'
iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=
PNG
upload_json="$(curl --fail --silent --show-error \
  -H 'accept: application/json' \
  -F "images=@${tmp_png};type=image/png;filename=kodex-ios-e2e.png" \
  "${gateway_url%/}/v1/uploads/images")"
uploaded_path="$(printf '%s' "$upload_json" | jq -r '.images[0].path')"
if [[ -z "$uploaded_path" || "$uploaded_path" == "null" ]]; then
  printf 'live image upload did not return an image path: %s\n' "$upload_json" >&2
  exit 1
fi
image_input_body="$(jq -nc --arg path "$uploaded_path" '{input:[{type:"text",text:"Uploaded image from iOS live scenario"},{type:"localImage",path:$path}]}')"
api POST "/v1/threads/${project_thread_id}/input" "$image_input_body" | jq -e '.disposition | type == "string"' >/dev/null

sleep 1
queue_json="$(api POST "/v1/threads/${project_thread_id}/queued-inputs" '{"input":[{"type":"text","text":"queued from iOS live scenario"}]}' )"
queue_id="$(printf '%s' "$queue_json" | jq -r '.queuedInput.id')"
if api GET "/v1/threads/${project_thread_id}/queued-inputs" | jq -e --arg id "$queue_id" '.queuedInputs[] | select(.id == $id)' >/dev/null; then
  api POST "/v1/threads/${project_thread_id}/queued-inputs/${queue_id}/retry" >/dev/null || printf 'note: queued retry skipped; row is not in a retryable state\n' >&2
  api POST "/v1/threads/${project_thread_id}/queued-inputs/${queue_id}/steer" >/dev/null || printf 'note: queued steer skipped; no active turn was available\n' >&2
else
  printf 'note: queued input %s drained before retry/steer checks could run\n' "$queue_id" >&2
fi

delete_queue_json="$(api POST "/v1/threads/${project_thread_id}/queued-inputs" '{"input":[{"type":"text","text":"delete from iOS live scenario"}]}' )"
delete_queue_id="$(printf '%s' "$delete_queue_json" | jq -r '.queuedInput.id')"
if api GET "/v1/threads/${project_thread_id}/queued-inputs" | jq -e --arg id "$delete_queue_id" '.queuedInputs[] | select(.id == $id)' >/dev/null; then
  api DELETE "/v1/threads/${project_thread_id}/queued-inputs/${delete_queue_id}" >/dev/null
else
  printf 'note: queued input %s drained before delete check could run\n' "$delete_queue_id" >&2
fi

encoded_cwd="$(jq -nr --arg value "$repo_root" '$value|@uri')"
skills_json="$(api GET "/v1/skills?cwd=${encoded_cwd}")"
printf '%s' "$skills_json" | jq -e '.skills | type == "array"' >/dev/null

api GET /v1/notifications/native/status | jq -e 'type == "object"' >/dev/null
api DELETE /v1/notifications/apns/devices/kodex-ios-e2e-missing >/dev/null || true

approval_count="$(api GET '/v1/approvals?status=pending' | jq '.approvals | length')"
if [[ "${KODEX_IOS_LIVE_E2E_APPROVAL_ID:-}" != "" ]]; then
  decision="${KODEX_IOS_LIVE_E2E_APPROVAL_DECISION:-decline}"
  api POST "/v1/approvals/${KODEX_IOS_LIVE_E2E_APPROVAL_ID}/decision" "$(jq -nc --arg decision "$decision" '{decision:{decision:$decision}}')" >/dev/null
else
  printf 'note: approval decision scenario skipped; set KODEX_IOS_LIVE_E2E_APPROVAL_ID to exercise a known disposable pending approval (%s pending observed)\n' "$approval_count" >&2
fi

api POST "/v1/threads/${project_thread_id}/interrupt-current" >/dev/null || printf 'note: stop skipped; no active turn was available\n' >&2
api POST "/v1/threads/${project_thread_id}/archive" >/dev/null
api POST "/v1/threads/${chat_thread_id}/archive" >/dev/null
api GET /v1/sidebar/threads | jq -e --arg projectThreadId "$project_thread_id" --arg chatThreadId "$chat_thread_id" '[.pinnedThreads.threads[]?.id, .chatThreads.threads[]?.id, .projectThreads[]?.threads[]?.id] | index($projectThreadId) == null and index($chatThreadId) == null' >/dev/null

printf 'live gateway API scenarios passed against %s\n' "$gateway_url"
