#!/usr/bin/env bash
set -euo pipefail

base_url="${1:-http://127.0.0.1:8787}"

curl -fsS "$base_url/healthz" >/dev/null
curl -fsS "$base_url/readyz" >/dev/null
curl -fsS "$base_url/openapi.json" >/dev/null
curl -fsS "$base_url/v1/capabilities" >/dev/null

echo "kodex gateway smoke passed: $base_url"
