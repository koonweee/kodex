# Kodex iOS

`apps/ios` contains the native SwiftUI companion app for Kodex. It is intentionally a native client over the existing gateway, not a wrapped copy of the React app.

## Toolchain

Required:

- Full Xcode, not only Command Line Tools.
- At least one iOS Simulator runtime installed from Xcode Settings > Platforms.
- Homebrew helpers:

```bash
brew install xcodegen xcbeautify
```

Select full Xcode after installing it:

```bash
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
sudo xcodebuild -license accept
xcodebuild -runFirstLaunch
```

Verify the local machine:

```bash
apps/ios/scripts/doctor.sh
```

The current checkout can run pure Swift package tests with Command Line Tools, but simulator build and UI tests require full Xcode plus an iOS runtime.

## Gateway URLs

The simulator default is:

```text
http://127.0.0.1:8787
```

Physical devices cannot use the Mac simulator's loopback address. Use a reachable trusted LAN, VPN, or tailnet URL for the gateway. Kodex still has no MVP gateway auth; do not expose it directly to the public internet.

## API Generation

The iOS client consumes the gateway OpenAPI contract. `KodexAPI` keeps checked-in Swift OpenAPI `Client`/`Types` sources plus generated operation metadata so normal SwiftPM and Xcode builds do not need to run code generation or reach the network. With a gateway running:

```bash
apps/ios/scripts/generate-api.sh
```

Set `KODEX_GATEWAY_URL` to fetch from a non-default local gateway:

```bash
KODEX_GATEWAY_URL=http://127.0.0.1:8787 apps/ios/scripts/generate-api.sh
```

The script fetches `openapi.json`, copies it into the `KodexAPI` target, regenerates `Sources/KodexAPI/GeneratedSources/Client.swift` and `Types.swift` with Swift OpenAPI Generator, and refreshes `Sources/KodexAPI/Generated/KodexAPIOperation.swift` from operation IDs.

The generator uses defensive naming because the gateway schema includes both camelCase and snake_case payload keys that collide under idiomatic Swift naming. The generator also warns on OpenAPI `null` schemas; keep manual bridges narrow for those gaps, multipart uploads, and raw/free-form JSON payloads, while keeping route inventory and generated operation coverage anchored to the checked-in OpenAPI artifacts.

## Build And Test

Generate the Xcode project:

```bash
cd apps/ios
xcodegen generate
```

Run the Swift package tests that do not require an iOS simulator:

```bash
cd apps/ios
swift test
```

The app also supports simulator UI-test fixture launch modes so workspace, degraded, and offline screens do not require a live Rust gateway:

```text
--fixture-connected
--fixture-degraded
--fixture-offline
```

These modes exercise native workspace/thread/timeline rendering, composer chrome, approvals, and notification payload routing with thin fixture/view models. Live gateway decoding remains intentionally thin and snapshot-oriented; the generated Swift OpenAPI client and checked-in contract define the route inventory, while `KodexCore` owns native view models and service helpers.
Live mode uses the editable gateway URL to load real account readiness, sidebar snapshots, selected-thread snapshots, queued inputs, approvals, skills, composer sends, image uploads, Stop, pin/archive/notification actions, and notification registration.

Codex should prefer the Build iOS Apps plugin / XcodeBuildMCP for simulator build, test, launch, screenshot, and UI inspection. Configure the session with:

- project: `apps/ios/KodexIOS.xcodeproj`
- scheme: `KodexIOS`
- simulator: the iPhone selected by `doctor.sh`
- bundle id: `dev.kodex.KodexIOS`

After `doctor.sh` reports an available iPhone simulator, run the app build and tests:

```bash
xcodebuild build -project apps/ios/KodexIOS.xcodeproj -scheme KodexIOS -destination 'platform=iOS Simulator,name=<doctor-selected-iPhone>' | xcbeautify
xcodebuild test -project apps/ios/KodexIOS.xcodeproj -scheme KodexIOS -destination 'platform=iOS Simulator,name=<doctor-selected-iPhone>' | xcbeautify
```

Run the optional live smoke against a ready, authenticated gateway:

```bash
KODEX_GATEWAY_URL=http://127.0.0.1:8787 apps/ios/scripts/run-live-e2e.sh
```

The script exits `77` with a skip reason when the gateway is unreachable, app-server is not ready, no simulator is available, or Codex/OpenAI auth is required.

Simulator push fixtures can be exercised against a booted simulator app:

```bash
xcrun simctl push booted dev.kodex.KodexIOS apps/ios/Fixtures/unread-agent-message.apns
```

The gateway APNs routes manage native device registration and status separately from browser Web Push. Real APNs delivery is intentionally not enabled by the scaffold until Apple developer credentials and gateway provider configuration are supplied.

Gateway APNs provider settings are separate from VAPID:

```bash
KODEX_APNS_TEAM_ID=ABCDE12345
KODEX_APNS_KEY_ID=ABC123DEFG
KODEX_APNS_PRIVATE_KEY_PATH=/path/to/AuthKey_ABC123DEFG.p8
```
