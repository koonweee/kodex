#!/usr/bin/env bash
set -euo pipefail

gateway_url="${KODEX_GATEWAY_URL:-http://127.0.0.1:8787}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ios_dir="$(cd "$script_dir/.." && pwd)"

if ! command -v jq >/dev/null 2>&1; then
  printf 'skip: jq is required to inspect gateway readiness/account JSON\n' >&2
  exit 77
fi

if ! curl --fail --silent --show-error "${gateway_url%/}/healthz" >/dev/null; then
  printf 'skip: gateway is not reachable at %s\n' "$gateway_url" >&2
  exit 77
fi

ready_json="$(curl --fail --silent --show-error "${gateway_url%/}/readyz" || true)"
if ! printf '%s' "$ready_json" | jq -e '.ready == true' >/dev/null 2>&1; then
  printf 'skip: gateway is reachable but app-server is not ready: %s\n' "$ready_json" >&2
  exit 77
fi

if ! account_json="$(curl --fail --silent --show-error "${gateway_url%/}/v1/account")"; then
  printf 'skip: gateway account probe failed at %s/v1/account\n' "${gateway_url%/}" >&2
  exit 77
fi
if ! printf '%s' "$account_json" | jq -e 'has("requiresOpenaiAuth") and (.requiresOpenaiAuth | type == "boolean")' >/dev/null 2>&1; then
  printf 'skip: gateway account response is not usable: %s\n' "$account_json" >&2
  exit 77
fi
if printf '%s' "$account_json" | jq -e '.requiresOpenaiAuth == true and (.account == null)' >/dev/null 2>&1; then
  printf 'skip: OpenAI auth is required before live iOS E2E can send prompts\n' >&2
  exit 77
fi

cd "$ios_dir"
xcodegen generate
"$ios_dir/scripts/run-live-e2e-api-scenarios.sh"

simulator_name="${KODEX_IOS_SIMULATOR_NAME:-$(./scripts/doctor.sh | sed -n 's/^selected-simulator-name: //p' | head -n 1)}"
if [[ -z "$simulator_name" ]]; then
  printf 'skip: no iOS simulator selected by doctor.sh\n' >&2
  exit 77
fi

KODEX_IOS_LIVE_E2E=1 KODEX_GATEWAY_URL="$gateway_url" \
  xcodebuild test \
    -project KodexIOS.xcodeproj \
    -scheme KodexIOSLiveE2E \
    -destination "platform=iOS Simulator,name=${simulator_name}" \
    -only-testing:KodexIOSUITests/KodexIOSUITests/testLiveGatewayE2ESmokeWhenEnabled \
    CODE_SIGNING_ALLOWED=NO

xcrun simctl launch booted dev.kodex.KodexIOS --ui-testing --fixture-connected >/dev/null
xcrun simctl push booted dev.kodex.KodexIOS "$ios_dir/Fixtures/unread-agent-message.apns" >/dev/null
data_container="$(xcrun simctl get_app_container booted dev.kodex.KodexIOS data)"
preferences_path="$data_container/Library/Preferences/dev.kodex.KodexIOS.plist"
for _ in {1..20}; do
  routed_thread_id="$(plutil -extract lastNotificationRouteThreadID raw -o - "$preferences_path" 2>/dev/null || true)"
  if [[ "$routed_thread_id" == "fixture-thread" ]]; then
    break
  fi
  sleep 0.5
done
if [[ "${routed_thread_id:-}" != "fixture-thread" ]]; then
  printf 'simulator push fixture did not route to fixture-thread; observed %s\n' "${routed_thread_id:-<none>}" >&2
  exit 1
fi
xcrun simctl terminate booted dev.kodex.KodexIOS >/dev/null || true
printf 'simulator push fixture routed to fixture-thread\n'
