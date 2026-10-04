#!/usr/bin/env bash
set -euo pipefail

source_script="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/generate-app-server-schema.sh"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT
mkdir -p "$test_root/repo/apps/gateway/scripts" "$test_root/bin"
cp "$source_script" "$test_root/repo/apps/gateway/scripts/"
generator="$test_root/repo/apps/gateway/scripts/generate-app-server-schema.sh"
schema_dir="$test_root/repo/apps/gateway/app-server-schema/0.160.0"
mkdir -p "$schema_dir/json"
printf 'keep this schema\n' > "$schema_dir/json/sentinel"

cat > "$test_root/bin/codex" <<'EOF'
#!/usr/bin/env bash
echo 'the generator must not choose codex from PATH' >&2
exit 99
EOF
cat > "$test_root/selected-codex" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
for forbidden in CODEX_ACCESS_TOKEN CODEX_API_KEY CODEX_TEST_STORAGE_OVERRIDE OPENAI_API_KEY OPENAI_BASE_URL; do
  if printenv "$forbidden" >/dev/null; then
    echo "inherited environment override reached selected Codex: $forbidden" >&2
    exit 11
  fi
done
[[ -d "$CODEX_HOME" && "$CODEX_HOME" != "$INHERITED_CODEX_HOME" ]]
[[ -d "$CODEX_SQLITE_HOME" && "$CODEX_SQLITE_HOME" != "$INHERITED_SQLITE_HOME" ]]
[[ "$(pwd -P)" == "$(cd "$CODEX_HOME" && pwd -P)" ]]
[[ "$0" == /* ]]
printf '%s\n' "$1" >> "$FAKE_ENV_CALL_RECORD"
if [[ "$1" == --version ]]; then
  echo "codex-cli ${FAKE_CODEX_VERSION:-0.160.0}"
  exit
fi
[[ "$1 $2 $3 $4" == 'app-server generate-json-schema --experimental --out' ]]
printf '%s\n' "$CODEX_HOME" > "$FAKE_CALL_RECORD"
mkdir -p "$5"
printf '{"type":"object"}\n' > "$5/ClientRequest.json"
if [[ "${FAKE_GENERATION_FAIL:-0}" == 1 ]]; then
  exit 7
fi
EOF
chmod +x "$test_root/bin/codex" "$test_root/selected-codex"
export PATH="$test_root/bin:$PATH"
export FAKE_CALL_RECORD="$test_root/called"
export FAKE_ENV_CALL_RECORD="$test_root/environment-calls"
export INHERITED_CODEX_HOME="$test_root/user-codex"
export INHERITED_SQLITE_HOME="$test_root/user-sqlite"
export CODEX_HOME="$INHERITED_CODEX_HOME"
export CODEX_SQLITE_HOME="$INHERITED_SQLITE_HOME"
export CODEX_ACCESS_TOKEN='synthetic-access-token'
export CODEX_API_KEY='synthetic-api-key'
export CODEX_TEST_STORAGE_OVERRIDE="$test_root/inherited-storage"
export OPENAI_API_KEY='synthetic-provider-key'
export OPENAI_BASE_URL='https://fixture.invalid'

if FAKE_CODEX_VERSION=0.159.0 bash "$generator" 0.160.0 "$test_root/selected-codex" > "$test_root/mismatch.log" 2>&1; then
  echo 'version mismatch unexpectedly succeeded' >&2
  exit 1
fi
[[ -f "$schema_dir/json/sentinel" && ! -e "$FAKE_CALL_RECORD" ]]
[[ "$(cat "$FAKE_ENV_CALL_RECORD")" == '--version' ]]

(
  cd "$test_root"
  bash "$generator" 0.160.0 ./selected-codex
)
[[ -f "$schema_dir/json/ClientRequest.json" && ! -e "$schema_dir/json/sentinel" ]]
[[ "$(head -n 1 "$schema_dir/VERSION")" == 'codex-cli 0.160.0' ]]
[[ ! -e "$(cat "$FAKE_CALL_RECORD")" ]]
[[ ! -e "$INHERITED_CODEX_HOME" && ! -e "$INHERITED_SQLITE_HOME" ]]
[[ "$(cat "$FAKE_ENV_CALL_RECORD")" == $'--version\n--version\napp-server' ]]

printf 'keep published schema\n' > "$schema_dir/json/sentinel"
if FAKE_GENERATION_FAIL=1 bash "$generator" 0.160.0 "$test_root/selected-codex" > "$test_root/failure.log" 2>&1; then
  echo 'failed generation unexpectedly succeeded' >&2
  exit 1
fi
[[ -f "$schema_dir/json/sentinel" ]]
[[ ! -e "$(cat "$FAKE_CALL_RECORD")" ]]

if bash "$generator" ../outside "$test_root/selected-codex" > "$test_root/unsafe-version.log" 2>&1; then
  echo 'unsafe schema directory label unexpectedly accepted' >&2
  exit 1
fi
printf 'schema generator tests passed\n'
