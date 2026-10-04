#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
if [[ $# != 2 ]]; then
  echo "usage: $0 <expected-version> <codex-executable>" >&2
  exit 2
fi
version="$1"
codex_binary="$2"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$ ]]; then
  echo "invalid schema version: $version" >&2
  exit 2
fi
if [[ ! -f "$codex_binary" || ! -x "$codex_binary" ]]; then
  echo "codex executable must name an executable file: $codex_binary" >&2
  exit 2
fi
# Resolve the selection before run_codex changes to its disposable working directory.
while :; do
  codex_binary="$(cd -P "$(dirname "$codex_binary")" && pwd -P)/$(basename "$codex_binary")"
  [[ -L "$codex_binary" ]] || break
  selected_target="$(readlink "$codex_binary")"
  if [[ "$selected_target" == /* ]]; then
    codex_binary="$selected_target"
  else
    codex_binary="$(dirname "$codex_binary")/$selected_target"
  fi
done

schema_root="$repo_root/apps/gateway/app-server-schema"
schema_dir="$schema_root/$version"
mkdir -p "$schema_root"
generation_dir="$(mktemp -d "$schema_root/.generate-$version.XXXXXX")"
runtime_dir=""
cleanup() {
  if [[ -d "$generation_dir/previous" && ! -e "$schema_dir" ]]; then
    mv "$generation_dir/previous" "$schema_dir"
  fi
  rm -rf "$generation_dir"
  if [[ -n "$runtime_dir" ]]; then
    rm -rf "$runtime_dir"
  fi
}
trap cleanup EXIT
runtime_dir="$(mktemp -d)"
mkdir -p "$runtime_dir/codex-home" "$runtime_dir/sqlite-home" "$generation_dir/schema/json"

# Keep version probes and generation isolated from ambient desktop credentials,
# storage overrides, and repository configuration discovery.
run_codex() (
  while IFS= read -r environment_key; do
    case "$environment_key" in
      CODEX_*|OPENAI_API_KEY|OPENAI_BASE_URL) unset "$environment_key" ;;
    esac
  done < <(compgen -e)
  export CODEX_HOME="$runtime_dir/codex-home"
  export CODEX_SQLITE_HOME="$runtime_dir/sqlite-home"
  cd "$CODEX_HOME"
  exec "$codex_binary" "$@"
)
actual_version="$(run_codex --version)"
if [[ "$actual_version" != "codex-cli $version" ]]; then
  echo "schema version mismatch: expected codex-cli $version; selected executable reports $actual_version" >&2
  exit 1
fi
run_codex app-server generate-json-schema --experimental --out "$generation_dir/schema/json"
if [[ ! -s "$generation_dir/schema/json/ClientRequest.json" ]]; then
  echo "schema generation produced no ClientRequest.json" >&2
  exit 1
fi

cat > "$generation_dir/schema/VERSION" <<EOF
$actual_version
generated with: "$codex_binary" app-server generate-json-schema --experimental --out apps/gateway/app-server-schema/$version/json
EOF

# Keep the previously published contract intact until generation has succeeded.
if [[ -e "$schema_dir" ]]; then
  mv "$schema_dir" "$generation_dir/previous"
fi
mv "$generation_dir/schema" "$schema_dir"
