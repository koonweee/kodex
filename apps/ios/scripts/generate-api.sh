#!/usr/bin/env bash
set -euo pipefail

gateway_url="${KODEX_GATEWAY_URL:-http://127.0.0.1:8787}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ios_dir="$(cd "$script_dir/.." && pwd)"
output_path="${ios_dir}/openapi/openapi.json"
target_output_path="${ios_dir}/Sources/KodexAPI/openapi.json"
config_path="${ios_dir}/openapi/openapi-generator-config.yaml"
target_config_path="${ios_dir}/Sources/KodexAPI/openapi-generator-config.yaml"
operations_path="${ios_dir}/Sources/KodexAPI/Generated/KodexAPIOperation.swift"
tmp_path="$(mktemp)"

cleanup() {
  rm -f "$tmp_path"
}
trap cleanup EXIT

curl --fail --silent --show-error "${gateway_url%/}/openapi.json" --output "$tmp_path"

if command -v jq >/dev/null 2>&1; then
  jq empty "$tmp_path"
elif command -v python3 >/dev/null 2>&1; then
  python3 -m json.tool "$tmp_path" >/dev/null
else
  printf 'warning: jq or python3 not found; skipping JSON validation\n' >&2
fi

mkdir -p "$(dirname "$output_path")"
mv "$tmp_path" "$output_path"
trap - EXIT

printf 'Wrote %s from %s/openapi.json\n' "$output_path" "${gateway_url%/}"

mkdir -p "$(dirname "$target_output_path")"
cp "$output_path" "$target_output_path"
cp "$config_path" "$target_config_path"
printf 'Updated %s for Swift OpenAPI generation\n' "$target_output_path"

mkdir -p "$(dirname "$operations_path")"
{
  cat <<'SWIFT'
import Foundation
import KodexCore

// Generated from apps/ios/openapi/openapi.json by apps/ios/scripts/generate-api.sh.
// Keep this file checked in so normal SwiftPM and Xcode builds do not need
// network access or plugin execution.
public enum KodexAPIOperation: String, CaseIterable, Sendable {
SWIFT
  jq -r '
    .paths
    | to_entries[]
    | .value
    | to_entries[]
    | select(.value.operationId != null)
    | .value.operationId
  ' "$output_path" | sort | awk '
    function camel_case(value, parts, count, i, result) {
      count = split(value, parts, "_")
      result = parts[1]
      for (i = 2; i <= count; i++) {
        result = result toupper(substr(parts[i], 1, 1)) substr(parts[i], 2)
      }
      return result
    }
    {
      printf "    case %s = \"%s\"\n", camel_case($0), $0
    }
  '
  cat <<'SWIFT'

    public var operationId: String {
        rawValue
    }
}

public struct KodexGeneratedGatewayClient: Sendable {
    private let client: GatewayClient

    public init(client: GatewayClient) {
        self.client = client
    }

    public func execute(
        _ operation: KodexAPIOperation,
        route: GatewayRoute,
        method: GatewayHTTPMethod = .get,
        body: Data? = nil
    ) async -> Result<Data, GatewayClientError> {
        _ = operation
        return await client.send(route, method: method, body: body)
    }
}
SWIFT
} > "$operations_path"

printf 'Wrote %s from OpenAPI operationIds\n' "$operations_path"

(
  cd "$ios_dir"
  swift package --allow-writing-to-package-directory generate-code-from-openapi --target KodexAPI
)
