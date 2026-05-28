# Native iOS End-To-End Client Plan

## Context

Create an actual working native iOS Kodex client on top of the existing gateway. This plan succeeds the initial native iOS scaffold in [native-ios-app.md](native-ios-app.md): the scaffold proves SwiftUI, XcodeGen, simulator build/test, route helpers, fixtures, and APNs registration plumbing, but it is not yet a live client.

The target is an idiomatic iOS companion app, not a web UI clone. The app should use native iOS navigation, sheets, menus, swipe actions, refresh, text editing, photo/file pickers, notifications, and background/foreground lifecycle handling while preserving Kodex's gateway-owned state model.

Relevant repository seams:

- `apps/ios/Sources/KodexIOS/ConnectionView.swift` is currently fixture-first. `refreshFixture()` reloads local fixture state, selected thread detail is fixture-backed, and primary action buttons are mostly placeholders.
- `apps/ios/Sources/KodexCore/GatewayProbe.swift` contains a manual `GatewayClient`, fixture models, and readiness helpers. These are useful seams, but they are not a generated contract client.
- `apps/ios/Sources/KodexAPI/KodexAPI.swift` is a placeholder. The real client must be generated from `GET /openapi.json` and wrapped by thin domain services.
- `apps/ios/Sources/KodexCore/URLSessionGatewayLoader.swift` and `LiveUpdates.swift` already sketch URLSession loading and canonical live event parsing, but the app does not yet use them as the live workspace source of truth.
- `apps/web/src/api/client.ts` inventories the route surface the native client needs for sidebar, thread detail, timeline pages, composer input, queued input, uploads, approvals, account, skills, notifications, and thread actions.
- `apps/web/src/timeline/useSelectedThreadTimeline.ts` is the reference for snapshot-first selected-thread loading: load `GET /v1/threads/{threadId}`, then converge through gateway canonical `thread_view.patch` and `thread_view.refresh_required`.
- `apps/web/src/composer/useComposerOrchestration.ts` is the reference for existing send, upload, queued-input, steer, optimistic, and stop behavior.
- `AGENTS.md` requires generated OpenAPI as the public contract, gateway ownership for shared lifecycle state, and same-user multi-client correctness for thread/project/session state.

## Working Definition Of E2E

The first complete version of this plan is done when an iOS Simulator can connect to a locally running gateway, then:

- verify gateway and account readiness;
- list real projects, chats, pinned threads, unread state, and selected-thread summaries;
- create a real chat thread and a real project thread;
- open a real thread snapshot and older timeline page;
- send a real text prompt, observe the turn progress, and render the assistant response without manual refresh;
- upload and send image attachments;
- use `$skill` mentions through the gateway skill catalog;
- stop the selected active thread through the current-thread interrupt route;
- view, retry, steer, and delete gateway-owned queued inputs;
- view and decide pending approvals;
- pin, rename, archive, mark seen, and toggle per-thread notifications;
- recover from app foregrounding, gateway restart, missed live events, and a second web or iOS client mutating the same gateway state.

## Current Status

Status as of 2026-05-28: complete. The native client implementation, deterministic fixture UI coverage, generated Swift API client, local simulator build/test workflow, and live smoke harness are in place. The live smoke passes against the local gateway when `/v1/account` returns an account profile, even if the legacy `requiresOpenaiAuth` flag remains true. The plan is simulator-only; physical-device connectivity is out of scope.

With a running gateway and account profile, `apps/ios/scripts/run-live-e2e.sh` now covers readiness/account checks, simulator selection, generated project refresh, live API scenarios, live iOS launch, live chat creation, `Say pong` send, canonical assistant-response rendering, and a `simctl push` fixture that routes to the intended thread. The API scenario script also creates disposable project/chat threads and verifies:

- project-thread creation and selection;
- older timeline pagination on a real thread with history;
- image upload and local image input;
- queued input route coverage, with create and best-effort steer/delete checks when rows remain available, plus best-effort Stop when the live gateway has an active turn;
- pin, rename, archive, mark-seen, and notification-toggle convergence;
- same-gateway convergence through fresh canonical thread/sidebar snapshots after cross-client-style mutations.

## Non-Goals For This Plan

- Pixel-perfect parity with the React/Mantine web app.
- Browser-specific implementation details such as DOM virtualization or browser `EventSource` as an app architecture concept.
- Running `codex app-server` on the iPhone.
- Public internet exposure, public gateway auth, or a hardened multi-user deployment boundary.
- Production APNs provider delivery. APNs registration/status/test route plumbing can be used, but actual provider credentials and delivery operations remain a separate release milestone.
- Full preferences/admin surfaces for automations, project previews, MCP manager, plugin installation, or Kodex control.
- A custom UIKit timeline engine unless SwiftUI profiling shows a concrete need.

## Milestones

### 0. Normalize The Native Plan Boundary

Scope: `plans/native-ios-app.md`, `plans/index.md`, and iOS docs.

Work:

- Treat [native-ios-app.md](native-ios-app.md) as the completed scaffold/tooling/APNs-plumbing plan.
- Keep this plan as the owner for live E2E client behavior.
- Update plan status text only if implementation changes the boundary or exit criteria.

Exit criteria:

- `plans/index.md` lists this plan as `Proposed` before implementation starts.
- The completed native scaffold plan does not claim that Kodex already has a production-ready live iOS client.

### 1. Generated Swift API Client And Transport

Scope: `apps/ios/Package.swift`, `apps/ios/project.yml`, `apps/ios/openapi`, `apps/ios/Sources/KodexAPI`, `apps/ios/Sources/KodexCore/Gateway`, and tests.

Work:

- Configure Swift OpenAPI Generator for the iOS package/project instead of leaving `KodexAPI` as a placeholder.
- Fetch `GET /openapi.json` from a running gateway with `apps/ios/scripts/generate-api.sh` and commit the checked-in generated artifacts required by local builds.
- Wrap generated operations in a small domain-facing gateway service that owns:
  - base URL;
  - URLSession transport;
  - timeout policy;
  - request cancellation;
  - gateway error normalization;
  - decoding diagnostics for generated schema drift.
- Remove or quarantine handwritten request/response DTO duplicates. Keep handwritten types only as thin view models or fixture helpers.
- Handle generator gaps explicitly. If OpenAPI 3.1, free-form JSON, multipart upload, or raw payload fields are not representable by the generator, add the smallest documented bridge around generated types.

Exit criteria:

- `KodexAPI` compiles from generated OpenAPI artifacts in both Swift Package and Xcode project builds.
- Unit tests exercise representative generated operations for sidebar, thread detail, input submit, approval decision, account read, skills list, and native notification status.
- No new live-client code depends on handwritten gateway DTOs when a generated type exists.

### 2. Live Connection, Account Readiness, And App State

Scope: `KodexCore` stores, `KodexIOS` app root, connection settings, account readiness UI, and tests.

Work:

- Replace fixture-first live app state with explicit stores:
  - `GatewayConnectionStore`;
  - `AccountStore`;
  - `WorkspaceStore`;
  - `SelectedThreadStore`;
  - `ComposerStore`;
  - `ApprovalStore`.
- Keep fixture launch modes only for deterministic UI tests and previews.
- Persist the gateway base URL with native settings storage. Default simulator development to `http://127.0.0.1:8787`; keep trusted LAN/VPN/tailnet device setup outside this simulator-only plan.
- Load `GET /healthz`, `GET /readyz`, `GET /v1/capabilities`, and `GET /v1/account` during connection.
- Surface account states needed for E2E sends:
  - ready and authenticated;
  - gateway reachable but app-server degraded;
  - OpenAI auth required;
  - login pending/cancelable if the gateway starts login.
- Keep user-facing recovery native: refresh, retry, edit gateway URL, and foreground revalidation.

Exit criteria:

- A simulator can connect to a live gateway and render live readiness/account state.
- UI tests still cover connected, degraded, offline, and auth-required fixture states without a live Rust process.
- Unit tests cover invalid base URL, network failure, gateway degraded, account authenticated, and auth-required states.

### 3. Real Workspace, Sidebar, And Thread Navigation

Scope: workspace/sidebar stores, native navigation views, project/chat creation flows, thread action menus, and tests.

Work:

- Fetch `/v1/sidebar/threads` and normalize real projects, project threads, chats, pinned threads, unread state, thread status, cwd, and notification state.
- Implement native navigation:
  - iPhone: `NavigationStack` with workspace list and detail push;
  - iPad: `NavigationSplitView` with sidebar and selected thread detail.
- Implement pull-to-refresh and foreground refresh from gateway snapshots.
- Implement create-chat and create-project-thread flows using `/v1/chats/threads` and `/v1/threads`.
- Mark selected threads seen with `POST /v1/threads/{threadId}/seen`.
- Implement pin/unpin, rename, archive, and notification toggle through native menus, context menus, and swipe actions where appropriate.

Exit criteria:

- Simulator live smoke can list real sidebar data, create a chat, create a project thread, select both, and refresh after a gateway restart.
- Unit tests cover sidebar normalization, pinned/chats/project grouping, unread projection, thread creation response handling, and thread action mutations.
- UI fixture tests cover iPhone push navigation and iPad split navigation.

### 4. Real Thread Timeline Rendering

Scope: selected-thread store, timeline row mappers, SwiftUI timeline views, history paging, previews/fixtures, and performance tests.

Work:

- Fetch `GET /v1/threads/{threadId}` for canonical thread snapshots.
- Fetch older history from `GET /v1/threads/{threadId}/timeline/pages`.
- Render gateway canonical `ThreadTimelineSnapshot.rows` as native SwiftUI row view models:
  - user and assistant messages;
  - work rows and active work state;
  - tool/activity rows;
  - file-change rows;
  - image rows;
  - warning and error rows;
  - approval and queued-input affordance rows where included in the thread projection.
- Start with `ScrollView` plus `LazyVStack`. Add a UIKit-backed list only if long-thread profiling shows SwiftUI is not adequate.
- Preserve gateway ordering and cursor/revision semantics. Do not derive durable lifecycle state from client-observed event order.
- Add text selection/copy and native share/open affordances for rendered message and file rows where useful.

Exit criteria:

- Unit tests cover row mapping for each canonical row family the gateway emits.
- UI fixture tests cover empty, active, completed, long-thread, image, file-change, and error timelines.
- Live simulator smoke opens a real thread, loads a snapshot, scrolls older history, and keeps row order stable across refresh.

### 5. Composer, Attachments, Skills, Queue, And Stop

Scope: composer domain services, SwiftUI composer, upload service, skill autocomplete, queued-input views, and tests.

Work:

- Build a native bottom composer:
  - compact inline text input;
  - expanded compose sheet for long prompts and attachments;
  - native menus or sheets for model, reasoning effort, fast mode, sandbox/permissions, cwd-sensitive settings, and skills.
- Submit text inputs through `POST /v1/threads/{threadId}/input`.
- Handle `started`, `queued`, and `steered` dispositions exactly as gateway-owned state projections, not durable local truth.
- Upload images through `/v1/uploads/images`. Use a manual URLSession multipart bridge if generated multipart support is insufficient.
- Use `PhotosPicker` for images and `fileImporter` where gateway-supported attachment types require it.
- Implement `$skill` autocomplete from `/v1/skills` and send structured skill inputs plus text elements from generated payload types.
- Implement queued-input list, retry, steer, and delete routes.
- Implement selected-thread Stop through `POST /v1/threads/{threadId}/interrupt-current`.

Exit criteria:

- Live simulator smoke sends `Say pong` to a real gateway thread and renders the assistant response without manual refresh.
- Live simulator smoke uploads at least one image and sends it as `localImage` input when the gateway supports the file.
- Unit tests cover payload construction, skill mention ranges, image upload mapping, send disposition handling, queue mutations, and stop routing.
- A two-client test shape shows web and iOS converge when one client sends while the other observes or queues.

### 6. Approvals And Risky Actions

Scope: approval store, approval list/detail UI, decision submission, timeline integration, and tests.

Work:

- Fetch pending approvals from `/v1/approvals?status=pending`, filtered by selected thread where appropriate.
- Render native approval cards with command/file context from generated payload types.
- Submit decisions through `/v1/approvals/{approvalId}/decision`.
- Use native confirmation dialogs for risky approvals and destructive-looking commands.
- Refresh selected thread and approval list after decisions; rely on gateway state for cross-client convergence.

Exit criteria:

- Unit tests cover approval payload mapping and decision requests for accept/deny variants.
- UI fixture tests cover approval list, approval detail, accept, deny, and post-decision removal.

### 7. Snapshot-First Live Convergence

Scope: live update adapter, selected/global stream stores, foreground/background lifecycle, reconnection, and tests.

Work:

- Use native `URLSession` streaming wrapped as `AsyncSequence`. Keep browser `EventSource` terminology out of app-facing APIs.
- Start every selected thread from a gateway snapshot. Live events patch or invalidate the snapshot; they are not a durable transcript source.
- Consume only gateway-owned canonical events needed by the native client, including:
  - `thread_view.patch`;
  - `thread_view.refresh_required`;
  - `thread.read_updated`;
  - `thread.pin_updated`;
  - `thread.notifications_updated`;
  - `thread.upserted`;
  - queued-input events;
  - approval events;
  - account/rate-limit events where surfaced.
- Maintain selected-stream and global-stream deduplication consistent with the web client's event-scope rules.
- Refetch on stream uncertainty, missed cursor, app foregrounding, gateway restart, or schema drift.
- Keep polling as a fallback path behind the same stores for environments where streaming fails.

Exit criteria:

- Unit tests cover patch application, refresh-required refetch, reconnect cursor handling, selected/global deduplication, and polling fallback.
- Live simulator smoke observes turn progress and assistant response without manual refresh.

### 8. Native Notifications And Badging Integration

Scope: existing APNs registration routes, iOS notification controller, badge state, deep-link routing, simulator push fixtures, and docs.

Work:

- Use the existing APNs registration/status routes for device token registration and diagnostics.
- Keep production APNs provider delivery outside this plan unless credentials and delivery policy are supplied.
- Parse notification payloads and route to the correct native thread view.
- Keep badge/unread state derived from gateway-owned read state.
- Add simulator push fixtures using `xcrun simctl push` for unread-agent-message and test notification payloads.

Exit criteria:

- Unit tests cover payload parsing, route extraction, badge projection, token registration payload, and unregister/status flows.
- Simulator push fixture opens or selects the intended thread route.
- Docs clearly separate simulator/local notification validation from production APNs provider delivery.

### 9. E2E Harness, Documentation, And Review Loop

Scope: iOS scripts, XCTest plans, README, plan status, review artifacts, and CI-ready commands where practical.

Work:

- Add deterministic UI fixture tests for native screens that should not need a live gateway.
- Add a live E2E smoke script or XCTest plan that assumes a running gateway and configured account, then:
  - checks readiness/account;
  - creates a chat;
  - sends `Say pong`;
  - waits for a canonical timeline update;
  - performs stop/queue/approval/thread-action checks where fixtures can make them deterministic.
- Add clear skip behavior when the gateway, account, app-server, simulator runtime, or Codex binary is not ready.
- Document simulator setup in `README.md` and `apps/ios/README.md`.
- Run an independent review/fix loop before marking the plan complete.

Exit criteria:

- `apps/ios/scripts/doctor.sh` passes.
- `cd apps/ios && xcodegen generate` passes.
- `cd apps/ios && swift test` passes.
- `xcodebuild build -project apps/ios/KodexIOS.xcodeproj -scheme KodexIOS -destination 'platform=iOS Simulator,name=<doctor-selected-iPhone>' CODE_SIGNING_ALLOWED=NO` passes.
- `xcodebuild test -project apps/ios/KodexIOS.xcodeproj -scheme KodexIOS -destination 'platform=iOS Simulator,name=<doctor-selected-iPhone>' CODE_SIGNING_ALLOWED=NO` passes.
- Live simulator E2E smoke passes against a running gateway with an authenticated account.
- Backend focused tests pass for any route or contract changes.
- `cd apps/web && npm test` and `cd apps/web && npm run build` pass if OpenAPI or shared gateway contract output changes.
- `plans/index.md` is updated from `Proposed` to `Active` when implementation begins and to `Complete` only after all exit criteria pass.

## Implementation Order

1. Generated Swift API client and transport.
2. Live connection, readiness, account state, and fixture/live app-state split.
3. Real workspace/sidebar/thread creation/navigation.
4. Thread snapshot and timeline rendering.
5. Composer, uploads, skills, queue, and stop.
6. Approvals and thread actions.
7. Snapshot-first live convergence and polling fallback.
8. Notification routing/badging.
9. Live E2E harness, docs, and review/fix loop.

This order intentionally gets a minimal live read path working before composer, then gets a real send/observe loop working before polishing approvals, notifications, and broad thread actions.

## Risks And Follow-Ups

- Swift OpenAPI Generator may not cleanly support every gateway schema shape, especially OpenAPI 3.1 details, free-form `Value` payloads, multipart upload, and raw app-server payload fields. The fallback should be a narrow bridge, not a handwritten duplicate API layer.
- Real prompt sends depend on the gateway's configured Codex app-server and account state. The iOS app should surface auth/readiness clearly rather than hiding failures behind generic network errors.
- Physical device testing is outside this simulator-only plan. Simulator `127.0.0.1` remains the supported E2E target here.
- Same-gateway correctness must remain gateway-owned. If a behavior must converge across web and iOS, the source of truth belongs in the gateway or app-server, not in SwiftUI state.
- Production APNs provider delivery needs credentials, environment policy, and delivery retry semantics. This plan only requires native registration, payload parsing, simulator push fixtures, and badge/deep-link behavior.
- Long timeline performance should be measured before adding UIKit virtualization. SwiftUI `LazyVStack` is the default until profiling proves otherwise.
