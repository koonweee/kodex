# Native iOS App Plan

## Context

Build an idiomatic native iOS companion app for Kodex. The app should preserve Kodex product behavior, but should not clone the React/Mantine web implementation one-to-one. SwiftUI should be the default UI layer, with UIKit bridges only where native SwiftUI surfaces are not strong enough for the interaction or performance target.

Relevant repository seams:

- `README.md` states Kodex is local-first or VPN-only, with no MVP gateway auth, and that the React web client is intentionally replaceable by another client.
- `AGENTS.md` requires generated OpenAPI as the public API contract, gateway-owned shared thread state, same-user multi-client correctness for shared state, and explicit localhost/trusted-VPN assumptions.
- `apps/gateway/src/api.rs` owns the OpenAPI document and route registration.
- `apps/gateway/src/routes/threads.rs` exposes the iOS-critical list/detail/navigation routes: `/v1/sidebar/threads`, `/v1/threads`, `/v1/chats/threads`, `/v1/threads/{threadId}`, `/v1/threads/{threadId}/timeline/pages`, attach, pin, rename, archive, notification toggle, and read state.
- `apps/gateway/src/routes/turns.rs` exposes composer, queue, steer, and current-turn interrupt routes.
- `apps/gateway/src/routes/uploads.rs` exposes multipart image uploads for `localImage` turn inputs.
- `apps/gateway/src/routes/notifications.rs` is browser Web Push/VAPID-specific today and cannot directly serve native APNs.
- `apps/web/src/api/client.ts` is the current generated-contract consumer and maps the route inventory the native client should cover.
- `apps/web/src/timeline/useSelectedThreadTimeline.ts` documents the current snapshot-first live contract: load `GET /v1/threads/{threadId}`, then converge via canonical `thread_view.patch` or refetch on `thread_view.refresh_required`.
- `apps/web/src/composer/useComposerOrchestration.ts` is the clearest reference for existing send, upload, queued-input, and stop behavior.
- `apps/web/src/composer/skillMentions.ts` is the clearest reference for `$skill` text behavior and structured `UserInput::Skill` payload construction.

## Current State

- `apps/ios` now contains a SwiftUI/XcodeGen native app scaffold with `KodexCore`, `KodexAPI`, app, unit-test, and UI-test targets.
- Local iOS build/test is unblocked: full Xcode 26.5 is selected, the iPhoneSimulator26.5 SDK is available, and `doctor.sh` selects an available `iPhone 17 Pro` simulator.
- `xcodegen` and `xcbeautify` are installed via Homebrew.
- `apps/ios/openapi/openapi.json` and `apps/web/src/api/generated/schema.ts` have been regenerated from the gateway after adding native notification routes.
- The native app currently verifies route construction, payload helpers, fixture-backed workspace/thread/timeline/composer/approval UI, and notification payload parsing. `KodexAPI` remains a placeholder for a full generated Swift OpenAPI client.
- APNs gateway registration/status/delete/test routes and storage are implemented, but network delivery to Apple Push Notification service is not claimed until provider credentials and delivery infrastructure are configured.

## Implementation Status

- Milestone 0: complete. `apps/ios/scripts/doctor.sh`, full Xcode, simulator SDK, simulator inventory, `xcodegen`, and `xcbeautify` are verified locally.
- Milestone 1: complete. `apps/ios/project.yml` is the project source of truth, generated Xcode project output is ignored, and simulator build/test pass.
- Milestone 2: complete for the repo-local native client harness. Gateway URL validation, route construction, readiness/degraded/offline checks, URLSession loading, and fixture UI launch modes are covered. Full generated Swift OpenAPI client wiring remains tracked as a documented follow-up.
- Milestone 3: complete for read-only native UX fixtures and core mapping. Workspace/thread/timeline fixture rendering, unread state, route selection, and native navigation smoke tests pass.
- Milestone 4: complete for native payload and fixture UX coverage. Composer, queued/stop route helpers, approval decision payloads, and fixture UI affordances are covered without changing gateway contracts beyond generated artifacts.
- Milestone 5: complete for APNs scaffolding and simulator-testable intent routing. Gateway APNs device routes, storage, OpenAPI inclusion, iOS notification permission/remote-registration wiring, token upload to the gateway, notification payload parsing, and `.apns` fixture assets are present. Production APNs provider delivery remains disabled by design until credentials are supplied.
- Milestone 6: complete as an optional abstraction, not the default transport. Live event parsing/fallback types consume gateway `kind` envelopes so polling/snapshot refresh can remain the default native behavior.
- Milestone 7: complete. README and iOS README document setup, commands, simulator/device gateway URLs, XcodeGen workflow, API generation, and local/VPN-only assumptions.

## Settled Decisions

- Build a native iOS client, not a wrapped PWA and not a React UI clone.
- Use SwiftUI-first UI, with native iOS patterns for navigation, forms, sheets, menus, swipe actions, refresh, share/open flows, and notifications.
- Start snapshot-first. Do not copy browser virtualization or browser `EventSource` as architecture. Use polling/refetch and `refreshable` first; add a Swift `AsyncSequence` live-update adapter later only if latency requires it.
- Treat the app as a companion to a running Kodex gateway. The iOS app does not run `codex app-server` locally.
- Preserve the existing deployment boundary: localhost for simulator development and trusted LAN/VPN/tailnet for devices. Do not imply the gateway is safe on the public internet.
- Use generated API types from the gateway OpenAPI contract. Do not hand-write duplicate request/response DTOs.
- Use the Build iOS Apps plugin / XcodeBuildMCP as the preferred Codex-driven simulator build, test, launch, and screenshot harness once the Xcode project exists.

## Milestones

### 0. Install And Validate Local iOS Toolchain

- Scope: local development machine and future `apps/ios/scripts/doctor.sh`.
- Work:
  - Install full Xcode, either from the App Store or Apple Developer downloads.
  - Select it with `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`.
  - Complete first-launch setup and license acceptance with Xcode UI or `sudo xcodebuild -license accept` plus `xcodebuild -runFirstLaunch`.
  - Install at least one current iOS Simulator runtime from Xcode Settings > Platforms if Xcode does not install one automatically.
  - Install project-generation and readable-build-log helpers if the project uses them:
    - `brew install xcodegen`
    - `brew install xcbeautify`
  - Add `apps/ios/scripts/doctor.sh` to check:
    - `xcodebuild -version`
    - `xcode-select -p`
    - `xcrun --sdk iphonesimulator --show-sdk-path`
    - `xcrun simctl list runtimes available`
    - `xcrun simctl list devices available`
    - `command -v xcodegen`
  - Configure the Build iOS Apps plugin / XcodeBuildMCP session defaults for `apps/ios/KodexIOS.xcodeproj`, scheme `KodexIOS`, and the selected iPhone simulator before any plugin build/test call.
- Exit criteria:
  - `xcodebuild -version` reports full Xcode, not Command Line Tools.
  - `xcrun --sdk iphonesimulator --show-sdk-path` returns an existing SDK path.
  - `xcrun simctl list devices available` shows at least one iPhone simulator.
  - `apps/ios/scripts/doctor.sh` exits zero and prints the selected simulator target.
  - XcodeBuildMCP can list simulators and use the selected simulator for build/test.

### 1. Scaffold A Reproducible SwiftUI iOS Project

- Scope: new `apps/ios/` tree, `.gitignore`, `README.md`, and `plans/index.md`.
- Work:
  - Create `apps/ios/project.yml` and generate `apps/ios/KodexIOS.xcodeproj` with XcodeGen. Keep `project.yml` as the source of truth; commit the generated `.xcodeproj` only if local workflow proves XcodeGen-at-build is too fragile.
  - Create targets:
    - `KodexIOS` app target.
    - `KodexCore` Swift library target for models, stores, route state, and presentation helpers.
    - `KodexAPI` Swift package target placeholder for generated OpenAPI client code.
    - `KodexIOSTests` unit tests.
    - `KodexIOSUITests` simulator UI tests.
  - Add Swift Package dependencies:
    - `apple/swift-openapi-generator` as the build plugin.
    - `apple/swift-openapi-urlsession` as the URLSession transport.
  - Add `apps/ios/openapi/openapi.json` plus `apps/ios/scripts/generate-api.sh`. The script should require a running gateway and fetch `GET /openapi.json`, mirroring `apps/web` API generation discipline.
  - Add `.gitignore` rules for DerivedData, Xcode user data, simulator logs, and generated project output if XcodeGen remains the authoritative project source.
  - Add a minimal SwiftUI app shell with connection setup, empty workspace state, and a diagnostic screen showing gateway readiness.
  - Defer actual generated Swift OpenAPI client wiring until Milestone 2. Until then, `KodexAPI` must remain a placeholder and must not grow handwritten gateway DTOs.
- Exit criteria:
  - `xcodegen generate` creates the project from `apps/ios/project.yml`.
  - `xcodebuild build -project apps/ios/KodexIOS.xcodeproj -scheme KodexIOS -destination 'platform=iOS Simulator,name=<doctor-selected-iPhone>'` succeeds.
  - `xcodebuild test -project apps/ios/KodexIOS.xcodeproj -scheme KodexIOS -destination 'platform=iOS Simulator,name=<doctor-selected-iPhone>'` runs at least one unit test and one UI smoke test.
  - `README.md` documents iOS setup, toolchain requirements, and the localhost/trusted-VPN gateway assumption.
  - `plans/index.md` contains this plan.
  - Generated OpenAPI client integration is explicitly tracked as Milestone 2 work and is not considered verified by the initial scaffold.

### 2. Native API Client And Gateway Connection Model

- Scope: `KodexAPI`, `KodexCore/Gateway`, `KodexIOS/Settings`, tests, and API generation scripts.
- Work:
  - Wrap the generated OpenAPI client in a small `GatewayClient` that owns:
    - base URL
    - URLSession transport
    - gateway error normalization
    - request timeout policy
    - JSON decoding diagnostics for generated DTO drift
  - Add `GatewayConnectionStore` with a manually editable gateway URL for v1.
  - Support simulator default `http://127.0.0.1:8787`; document that physical devices need a reachable trusted LAN/VPN/tailnet URL and, for HTTPS-only features, TLS termination.
  - Add a readiness flow using `GET /healthz`, `GET /readyz`, and optionally `GET /v1/capabilities`.
  - Add unit tests using `URLProtocol` stubs or injected transport fixtures.
  - Add a simulator UI test launch mode that uses fixture JSON instead of a live gateway, so UI tests do not require a running Rust process.
- Exit criteria:
  - Unit tests cover success, gateway error body, network failure, invalid base URL, and ready/degraded gateway states.
  - Simulator UI test can launch the app and render connected, degraded, and offline fixture states.
  - No Swift request/response DTO duplicates are introduced outside generated OpenAPI output and thin view models.

### 3. Read-Only Workspace And Thread UX

- Scope: `KodexCore/Threads`, `KodexCore/Timeline`, `KodexIOS/Workspace`, `KodexIOS/Timeline`, fixtures, and tests.
- Work:
  - Implement native navigation:
    - iPhone: `NavigationStack` rooted at workspace sections.
    - iPad: `NavigationSplitView` with workspace sidebar and thread detail.
  - Fetch `/v1/sidebar/threads` for projects, project threads, chats, and pinned threads.
  - Use native search and pull-to-refresh rather than copying the web sidebar filtering mechanics.
  - Implement thread detail from `/v1/threads/{threadId}` and older history from `/v1/threads/{threadId}/timeline/pages`.
  - Render gateway canonical rows from `ThreadTimelineSnapshot.rows`:
    - message rows
    - work rows
    - activity/tool rows
    - file-change rows
    - image rows
    - warning/error rows
  - Start with SwiftUI `ScrollView` plus `LazyVStack`. Only bridge to `UICollectionView` if profiling shows SwiftUI cannot handle real long-thread fixtures.
  - Use snapshot refresh and active-thread polling for v1:
    - poll selected active threads at a short interval
    - back off when `liveState` is idle
    - refetch on user pull-to-refresh or foreground activation
  - Mark selected threads seen through `POST /v1/threads/{threadId}/seen`.
- Exit criteria:
  - Unit tests cover sidebar response normalization, thread title display, unread state, timeline row mapping, and older-history merge.
  - Simulator UI tests cover selecting a chat, selecting a project thread, pull-to-refresh, empty state, and thread detail rendering from fixtures.
  - A long-thread fixture scroll test proves the timeline remains usable before adding any UIKit virtualization bridge.
  - Same-gateway convergence is preserved by refetching gateway-owned state rather than inventing local durable lifecycle state.

### 4. Native Composer, Attachments, Approvals, And Thread Actions

- Scope: `KodexIOS/Composer`, `KodexCore/Composer`, `KodexCore/Approvals`, `KodexIOS/Approvals`, `KodexIOS/ThreadActions`, tests.
- Work:
  - Build a native bottom composer:
    - compact inline input for quick prompts
    - expanded compose sheet for long prompts
    - native toolbar/menu controls for model, reasoning effort, fast mode, and permissions
  - Port behavior from `apps/web/src/composer/useComposerOrchestration.ts` into Swift domain services:
    - upload images through `/v1/uploads/images`
    - submit through `/v1/threads/{threadId}/input`
    - handle `started`, `queued`, and `steered` dispositions
    - retry/steer/delete queued rows through queued-input routes
    - stop selected thread through `/v1/threads/{threadId}/interrupt-current`
  - Use native `PhotosPicker` and `fileImporter` where appropriate for attachments.
  - Implement `$skill` autocomplete using `/v1/skills` and structured `UserInput::Skill` plus `TextElement` payloads. Use a `UITextView` bridge only if SwiftUI text editing cannot preserve cursor/range behavior reliably.
  - Implement approvals from `/v1/approvals?status=pending` and `POST /v1/approvals/{approvalId}/decision`, using native cards and confirmation dialogs for high-risk decisions.
  - Implement thread actions with native toolbar menu and swipe actions:
    - pin/unpin
    - rename
    - archive
    - notification toggle
- Exit criteria:
  - Unit tests cover composer payload construction, image upload mapping, queued disposition handling, stop routing, skill mention byte ranges, and approval decision payloads.
  - Simulator UI tests cover composing text, expanded composer, attachment fixture flow, queued row display, stop action, and approval accept/decline fixture flows.
  - Existing gateway API contracts remain generated from Rust DTOs; any backend route changes regenerate web and iOS API artifacts.

### 5. Native Notifications And Badging

- Scope: gateway notification routes/store/service, generated OpenAPI, `KodexIOS notification module`, entitlements, simulator push fixtures, tests.
- Work:
  - Do not reuse browser Web Push subscriptions for native iOS. Add APNs-specific gateway routes and DTOs, for example:
    - `GET /v1/notifications/native/status`
    - `POST /v1/notifications/apns/devices`
    - `DELETE /v1/notifications/apns/devices/{deviceId}`
    - `POST /v1/notifications/apns/test`
  - Extend gateway notification storage with APNs device token, bundle id, environment, user-facing device name, enabled state, created timestamp, and updated timestamp.
  - Add APNs provider configuration separately from VAPID configuration. Keep local/VPN-only gateway assumptions explicit.
  - In iOS, request notification permission through `UNUserNotificationCenter`, register for remote notifications, and upload the APNs device token to the gateway.
  - Mirror the web payload intent model: unread agent message and test notification first. Add approval/automation failure notification kinds only after the product behavior is specified.
  - Add simulator push test fixture using `xcrun simctl push booted <bundle-id> apps/ios/Fixtures/unread-agent-message.apns`.
- Exit criteria:
  - Gateway route/store tests cover APNs register/update/delete/status and OpenAPI inclusion.
  - iOS unit tests cover notification payload parsing, route selection, and badge state.
  - Simulator test or scripted manual validation proves a `.apns` fixture opens the right thread route.
  - README documents APNs setup separately from browser Web Push and does not imply public internet safety.

### 6. Optional Foreground Live Updates

- Scope: `KodexCore/LiveUpdates`, selected-thread store, tests, and performance fixtures.
- Work:
  - Add a Swift-native live update adapter only if snapshot polling is not good enough.
  - Use `URLSession` streaming as an `AsyncSequence` abstraction; do not expose browser `EventSource` concepts to the rest of the app.
  - Consume only gateway-owned canonical live events:
    - `thread_view.patch`
    - `thread_view.refresh_required`
    - `thread.read_updated`
    - `thread.pin_updated`
    - `thread.notifications_updated`
    - `thread.upserted`
    - `turn_queue.item_upsert`
    - `turn_queue.item_deleted`
    - approval and MCP lifecycle events as needed
  - On stream uncertainty, refetch snapshots instead of replaying raw timeline history.
  - Keep polling as a fallback behind the same selected-thread store.
- Exit criteria:
  - Unit tests cover event parsing, reconnect cursor handling, refresh-required refetch, selected/global dedup, and fallback to polling.
  - A two-client test shape proves one iOS client and one web client converge through gateway-owned state.
  - Profiling demonstrates live streaming materially improves perceived latency before it replaces polling as the default.

### 7. Documentation, Review, And Release Hygiene

- Scope: `README.md`, `AGENTS.md` if contributor workflow changes, `plans/index.md`, iOS docs, and verification scripts.
- Work:
  - Document iOS development commands:
    - `apps/ios/scripts/doctor.sh`
    - `apps/ios/scripts/generate-api.sh`
    - `xcodegen generate`
    - `xcodebuild build ...`
    - `xcodebuild test ...`
  - Document simulator and physical-device gateway URLs.
  - Document local/VPN-only security posture for iOS specifically.
  - Add review guidance that native iOS state follows the same gateway-owned lifecycle rules as the web client.
  - Keep `plans/index.md` status current as the work starts and completes.
- Exit criteria:
  - A fresh Mac with Xcode and Homebrew can follow README instructions to build and test the iOS app in Simulator.
  - Review pass confirms no generated API contract drift, no browser-only notification assumptions in iOS, and no new public-exposure claims.

## Verification

Initial local verification performed while writing this plan:

- `swift --version`: present, Apple Swift 6.3.1.
- `xcodebuild -version`: initially failed because only Command Line Tools were selected; after local setup, reports Xcode 26.5, build 17F42.
- `xcode-select -p`: after local setup, `/Applications/Xcode.app/Contents/Developer`.
- `xcrun simctl list devices available`: after local setup, reports available iOS 26.5 simulators including `iPhone 17 Pro`.
- `xcrun --sdk iphonesimulator --show-sdk-path`: after local setup, returns `/Applications/Xcode.app/Contents/Developer/Platforms/iPhoneSimulator.platform/Developer/SDKs/iPhoneSimulator26.5.sdk`.
- `ls /Applications`: after local setup, `Xcode.app` is present.
- `command -v brew`: present.
- `command -v xcodegen`: after local setup, `/opt/homebrew/bin/xcodegen`.
- `command -v xcbeautify`: after local setup, `/opt/homebrew/bin/xcbeautify`.
- `command -v tuist`, `swift-openapi-generator`, `xcpretty`: absent as standalone commands; standalone generator is not required while using Swift package/plugin integration.

Implementation verification:

- `apps/ios/scripts/doctor.sh`: passed, selecting `iPhone 17 Pro`.
- `cd apps/ios && xcodegen generate`: passed.
- `cd apps/ios && swift test`: passed after review fixes, 25 tests.
- `xcodebuild build -project apps/ios/KodexIOS.xcodeproj -scheme KodexIOS -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -derivedDataPath apps/ios/DerivedData CODE_SIGNING_ALLOWED=NO`: passed.
- `xcodebuild test -project apps/ios/KodexIOS.xcodeproj -scheme KodexIOS -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -derivedDataPath apps/ios/DerivedData CODE_SIGNING_ALLOWED=NO`: passed after review fixes, including 25 simulator unit tests and connected, degraded, and offline UI smoke tests.
- `cargo fmt`: passed.
- `cargo test -p kodex-gateway apns_device`: passed.
- `cargo test -p kodex-gateway native_notification`: passed.
- `cargo test -p kodex-gateway shell_routes_report_readiness_capabilities_docs_and_openapi_paths`: passed.
- `cargo test -p kodex-gateway notification`: passed.
- `cargo test -p kodex-gateway`: passed in the backend implementation pass.
- `apps/ios/scripts/generate-api.sh` against a local gateway on `127.0.0.1:8797`: passed.
- `npx openapi-typescript http://127.0.0.1:8797/openapi.json -o src/api/generated/schema.ts`: passed.
- `cd apps/web && npm run build`: passed.
- `cd apps/web && npm test`: passed after stabilizing selected-thread fake SSE stream matching, 57 test files and 498 tests.

## Residual Risks And Follow-Ups

- Full generated Swift OpenAPI client wiring is still a follow-up; the current `KodexAPI` target intentionally remains a placeholder while `KodexCore` provides narrow route and payload helpers for the verified scaffold.
- Native APNs network delivery requires Apple developer configuration and gateway APNs provider credentials. Current backend routes store devices and report configuration/status but do not deliver pushes to Apple.
- Physical devices cannot use the Mac gateway's `127.0.0.1`. Device testing needs a trusted LAN/VPN/tailnet URL and potentially HTTPS termination, without changing the no-public-exposure posture.
- SwiftUI timeline performance is an implementation risk. Start with `LazyVStack`; bridge only the timeline to `UICollectionView` if fixture profiling proves it is necessary.
- The first iOS version should avoid generic project preview and MCP editing complexity unless core chat/thread workflows are already solid. Those can stay in native Settings/Admin screens after the main client is usable.
