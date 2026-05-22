#!/usr/bin/env bash
set -euo pipefail

base_url="${1:-http://127.0.0.1:8787}"
thread_id="${2:-}"
output="${3:-/private/tmp/kodex-hot-path-profile-$(date +%Y%m%d%H%M%S).json}"

timeline_cursor="${KODEX_PROFILE_TIMELINE_CURSOR:-}"
project_thread_body="${KODEX_PROFILE_PROJECT_THREAD_BODY:-}"
chat_thread_body="${KODEX_PROFILE_CHAT_THREAD_BODY:-}"
input_thread_id="${KODEX_PROFILE_INPUT_THREAD_ID:-$thread_id}"
input_body="${KODEX_PROFILE_INPUT_BODY:-}"

rows_file="$(mktemp)"
trap 'rm -f "$rows_file"' EXIT
first_row=1

append_json_row() {
  if [[ "$first_row" -eq 0 ]]; then
    printf ',\n' >> "$rows_file"
  fi
  first_row=0
  printf '%s' "$1" >> "$rows_file"
}

json_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  printf '%s' "$value"
}

measure() {
  local name="$1"
  local method="$2"
  local path="$3"
  local body="${4:-}"
  local required="${5:-true}"
  local temp
  local timing
  local status
  local time_total
  local size_download
  temp="$(mktemp)"
  if [[ -n "$body" ]]; then
    timing="$(curl -sS -o "$temp" -w '%{http_code} %{time_total} %{size_download}' \
      -X "$method" -H 'content-type: application/json' --data "$body" "$base_url$path")"
  else
    timing="$(curl -sS -o "$temp" -w '%{http_code} %{time_total} %{size_download}' \
      -X "$method" "$base_url$path")"
  fi
  read -r status time_total size_download <<< "$timing"
  rm -f "$temp"
  append_json_row "$(printf '{"name":"%s","method":"%s","path":"%s","required":%s,"status":%s,"timeTotalSeconds":%s,"sizeDownloadBytes":%s}' \
    "$(json_escape "$name")" \
    "$(json_escape "$method")" \
    "$(json_escape "$path")" \
    "$required" \
    "$status" \
    "$time_total" \
    "$size_download")"
}

skip_measurement() {
  local name="$1"
  local reason="$2"
  append_json_row "$(printf '{"name":"%s","skipped":true,"reason":"%s"}' \
    "$(json_escape "$name")" \
    "$(json_escape "$reason")")"
}

measure "sidebar_snapshot" GET "/v1/sidebar/threads"

if [[ -n "$thread_id" ]]; then
  measure "selected_thread" GET "/v1/threads/$thread_id"
else
  skip_measurement "selected_thread" "pass a thread id as argument 2"
fi

if [[ -n "$thread_id" && -n "$timeline_cursor" ]]; then
  measure "timeline_page" GET "/v1/threads/$thread_id/timeline/pages?cursor=$timeline_cursor"
else
  skip_measurement "timeline_page" "set KODEX_PROFILE_TIMELINE_CURSOR and pass a thread id"
fi

if [[ -n "$project_thread_body" ]]; then
  measure "project_thread_create" POST "/v1/threads" "$project_thread_body"
else
  skip_measurement "project_thread_create" "set KODEX_PROFILE_PROJECT_THREAD_BODY to a JSON request body"
fi

if [[ -n "$chat_thread_body" ]]; then
  measure "chat_thread_create" POST "/v1/chats/threads" "$chat_thread_body"
else
  skip_measurement "chat_thread_create" "set KODEX_PROFILE_CHAT_THREAD_BODY to a JSON request body"
fi

if [[ -n "$input_thread_id" && -n "$input_body" ]]; then
  measure "thread_input_submit" POST "/v1/threads/$input_thread_id/input" "$input_body"
else
  skip_measurement "thread_input_submit" "set KODEX_PROFILE_INPUT_BODY and pass or set an input thread id"
fi

{
  printf '{\n'
  printf '  "baseUrl": "%s",\n' "$(json_escape "$base_url")"
  printf '  "generatedAt": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '  "measurements": [\n'
  cat "$rows_file"
  printf '\n  ],\n'
  printf '  "uxChecks": {\n'
  printf '    "firstVisibleThreadContent": "not_checked_by_http_profiler",\n'
  printf '    "composerEnabledState": "not_checked_by_http_profiler",\n'
  printf '    "pendingSendVisibility": "not_checked_by_http_profiler",\n'
  printf '    "scrollJump": "not_checked_by_http_profiler",\n'
  printf '    "duplicateRows": "not_checked_by_http_profiler",\n'
  printf '    "deferredContentAffordance": "not_checked_by_http_profiler"\n'
  printf '  },\n'
  printf '  "warnings": ["HTTP profiling cannot prove UX non-regression; pair this output with the browser profiling recipe."]\n'
  printf '}\n'
} > "$output"

printf 'wrote %s\n' "$output"
