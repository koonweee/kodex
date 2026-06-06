#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
export PATH="${CARGO_HOME:-$HOME/.cargo}/bin:$PATH"

cargo check --all-targets
cargo clippy --all-targets --all-features -- \
  -A clippy::all \
  -D dead-code \
  -D unused-imports \
  -D unused-mut \
  -D unused-variables \
  -D unreachable-pub

cargo_machete="${CARGO_HOME:-$HOME/.cargo}/bin/cargo-machete"
if [[ ! -x "$cargo_machete" ]]; then
  cat >&2 <<'EOF'
cargo-machete is required for dependency trimming.

Install it with:
  cargo install cargo-machete --locked
EOF
  exit 1
fi

"$cargo_machete" .

if [[ "${KODEX_TRIM_UDEPS:-0}" == "1" ]]; then
  if ! cargo +nightly udeps --version >/dev/null 2>&1; then
    cat >&2 <<'EOF'
cargo-udeps is optional but KODEX_TRIM_UDEPS=1 was set.

Install it with:
  cargo install cargo-udeps --locked

It also requires a nightly Rust toolchain.
EOF
    exit 1
  fi

  cargo +nightly udeps --all-targets
fi
