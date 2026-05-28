#!/usr/bin/env bash
set -euo pipefail

failures=0

section() {
  printf '\n== %s ==\n' "$1"
}

require_command() {
  local name="$1"
  if command -v "$name" >/dev/null 2>&1; then
    printf 'ok: %s -> %s\n' "$name" "$(command -v "$name")"
  else
    printf 'missing: %s\n' "$name"
    failures=$((failures + 1))
  fi
}

section "Developer Directory"
developer_dir="$(xcode-select -p 2>/dev/null || true)"
if [[ -z "$developer_dir" ]]; then
  printf 'missing: xcode-select has no active developer directory\n'
  failures=$((failures + 1))
else
  printf 'xcode-select: %s\n' "$developer_dir"
  if [[ "$developer_dir" == *"/CommandLineTools"* ]]; then
    printf 'error: Command Line Tools are selected; select full Xcode with sudo xcode-select -s /Applications/Xcode.app/Contents/Developer\n'
    failures=$((failures + 1))
  fi
fi

section "Required Commands"
require_command xcodebuild
require_command xcrun
require_command xcodegen

section "Xcode"
if xcodebuild -version; then
  :
else
  printf 'error: xcodebuild did not report a usable full Xcode installation\n'
  failures=$((failures + 1))
fi

section "iPhone Simulator SDK"
if sdk_path="$(xcrun --sdk iphonesimulator --show-sdk-path 2>/dev/null)" && [[ -d "$sdk_path" ]]; then
  printf 'ok: iphonesimulator SDK -> %s\n' "$sdk_path"
else
  printf 'missing: iPhone Simulator SDK. Install an iOS Simulator runtime in Xcode Settings > Platforms.\n'
  failures=$((failures + 1))
fi

section "Simulator Runtimes"
if xcrun simctl list runtimes available; then
  :
else
  printf 'error: simctl runtimes unavailable\n'
  failures=$((failures + 1))
fi

section "Simulator Devices"
devices_output="$(xcrun simctl list devices available 2>/dev/null || true)"
if [[ -n "$devices_output" ]]; then
  printf '%s\n' "$devices_output"
  selected_device="$(
    printf '%s\n' "$devices_output" |
      awk '/iPhone/ && /\(.*\)/ { sub(/^--.*$/, ""); print; exit }' |
      sed -E 's/^[[:space:]]*([^()]+)[[:space:]]+.*/\1/' |
      sed -E 's/[[:space:]]+$//'
  )"
  if [[ -n "$selected_device" ]]; then
    printf 'selected-simulator-name: %s\n' "$selected_device"
  else
    printf 'missing: no available iPhone simulator device found\n'
    failures=$((failures + 1))
  fi
else
  printf 'missing: no simulator devices listed\n'
  failures=$((failures + 1))
fi

section "Install Hints"
printf 'Full Xcode: install from the App Store or Apple Developer downloads.\n'
printf 'After install: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer\n'
printf 'Helpers: brew install xcodegen xcbeautify\n'

if [[ "$failures" -gt 0 ]]; then
  printf '\nDoctor failed with %s issue(s).\n' "$failures"
  exit 1
fi

printf '\nDoctor passed.\n'
