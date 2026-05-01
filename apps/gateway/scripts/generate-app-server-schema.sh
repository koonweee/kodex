#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
version="${1:-$(codex --version | awk '{print $2}')}"
schema_dir="$repo_root/apps/gateway/app-server-schema/$version"

rm -rf "$schema_dir"
mkdir -p "$schema_dir/json"

codex app-server generate-json-schema --out "$schema_dir/json"

cat > "$schema_dir/VERSION" <<EOF
codex-cli $version
generated with: codex app-server generate-json-schema --out apps/gateway/app-server-schema/$version/json
EOF
