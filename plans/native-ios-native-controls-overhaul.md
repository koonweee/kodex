# Native iOS Native Controls Overhaul Plan

Status: Complete.

## Context

Make the native iOS app feel more like an iOS app by replacing custom web-like SwiftUI chrome with platform primitives wherever the platform primitive carries the intended behavior. This plan covers the ten audit items from the native-iOS app review:

- Sidebar list/navigation should use native list and row semantics.
- Sidebar search should use `.searchable`.
- Workspace scope should use a segmented `Picker`.
- Settings should use `Form`, `Section`, and `LabeledContent`.
- Thread rows should not nest a `Menu` inside the primary row button.
- Collapsible sidebar groups should use native section/disclosure patterns.
- Sidebar title, actions, and footer should move toward native navigation chrome and safe-area/bar treatment.
- Composer option choices should use picker-style selection where possible.
- Liquid Glass usage should prefer native glass button/surface styles and keep custom effects centralized.
- Theme tokens should move from hardcoded black/white/RGB values toward semantic system colors and tint.

Decision from the planning interview: prioritize native iOS behavior first, even when it visibly changes the current custom dark Kodex visual design. Keep Kodex identity through restrained tint, icons, timeline/composer personality, and product-specific content hierarchy only where those choices do not fight platform behavior.

Relevant code seams:

- `apps/ios/Sources/KodexIOS/ConnectionView.swift` owns root navigation, selected-thread routing, live streams, composer state, service actions, and notification routing.
- `apps/ios/Sources/KodexIOS/Surfaces/WorkspaceDrawerView.swift` owns the current custom sidebar shell, filtering, scope selection, sections, sheet presentation, and callback wiring.
- `apps/ios/Sources/KodexIOS/Surfaces/Workspace/WorkspaceDrawerComponents.swift` owns `WorkspaceHeaderView`, `WorkspaceSearchField`, `WorkspaceFooterView`, `WorkspaceProjectSection`, and `ConnectionSettingsSheet`.
- `apps/ios/Sources/KodexIOS/UI/KodexRows.swift` owns the custom segmented control, disclosure row, thread row, and selected-row background.
- `apps/ios/Sources/KodexIOS/Surfaces/ThreadDetailView.swift` owns thread detail layout, native compact navigation bar usage, rename/expanded composer sheets, timeline scrolling, and keyboard dismissal.
- `apps/ios/Sources/KodexIOS/Surfaces/Thread/ThreadComposerBar.swift` owns composer text entry, attachment picker, permissions/model menus, and send/stop controls.
- `apps/ios/Sources/KodexIOS/Surfaces/Thread/TimelineRowView.swift`, `ThreadActionMenu.swift`, and `ThreadStatusCards.swift` own timeline, thread actions, approval, and queued-input presentation.
- `apps/ios/Sources/KodexIOS/UI/KodexGlass.swift`, `KodexButtons.swift`, `KodexComposerPrimitives.swift`, `KodexCards.swift`, and `KodexTheme.swift` own shared primitives and theme tokens.
- `apps/ios/Tests/KodexIOSUITests/KodexIOSUITests.swift` covers fixture drawer/detail/composer/settings behavior, compact back swipe, iPad split navigation, thread actions, and live smoke.
- `apps/ios/Tests/KodexCoreTests/NativeMilestoneTests.swift` covers native view-model normalization, route mapping, composer payloads, approvals, notifications, and live event parsing.

## Current State

- The app already uses native `NavigationStack` for compact thread routing and `NavigationSplitView` for regular width, but the sidebar content itself is custom `ZStack` plus `ScrollView` plus nested `VStack` with hidden navigation bar chrome.
- The workspace search field is a custom `TextField` in glass chrome instead of `.searchable`.
- The Projects/Chats selector is a custom button/capsule segmented control instead of `Picker(...).pickerStyle(.segmented)`.
- Sidebar sections use custom disclosure rows and manual section composition rather than native `Section`, `DisclosureGroup`, or hierarchical `List`.
- Thread rows are full-row `Button`s that contain an ellipsis `Menu`; in Simulator accessibility inspection they expose as pop-up buttons rather than ordinary rows with separate actions.
- Settings is a custom `ScrollView` with hand-built cards and dividers instead of a native `Form`.
- Composer menus use plain `Button` rows for model/reasoning/permissions choices; they work, but native `Picker` selection semantics would better communicate current values.
- Liquid Glass is centralized enough to be safe, but many callers still layer custom backgrounds, overlays, and glass effects instead of using native glass button styles where available.
- `KodexTheme` is hardcoded to black/white/RGB tokens, so the app does not adapt well to system color scheme, increased contrast, or future platform tint/material changes.
- `ConnectionView` is overgrown for a SwiftUI view, with many `@State` fields plus service construction, live stream lifecycle, and user actions. This is not strictly a visual-native issue, but it makes native routing/presentation changes riskier.

## Non-Goals

- Do not change gateway APIs, Rust DTOs, OpenAPI artifacts, or generated Swift API files unless an implementation milestone explicitly discovers a native UI requirement that cannot be met with current data.
- Do not re-clone the React/Mantine web UI. Web parity is subordinate to native iOS behavior in this plan.
- Do not remove the custom chat timeline/composer personality wholesale. Chat products need some custom UI; the target is to replace custom controls where the system already has the right control.
- Do not make the native iOS app safe to expose a gateway publicly. Keep the local/trusted VPN assumption unchanged.
- Do not require older screenshots/contact sheets to remain pixel-matched. Screenshots are regression and quality references, not source-of-truth visual specs for this native-first pass.

## Milestones

### 1. Native Foundation: Theme, Glass, And Control Policy

- Scope: `KodexTheme.swift`, `KodexGlass.swift`, `KodexButtons.swift`, `KodexComposerPrimitives.swift`, `KodexCards.swift`, `AGENTS.md` only if contributor guidance must be tightened.
- Work:
  - Reframe shared tokens around semantic system colors: `.primary`, `.secondary`, `Color(uiColor: .systemBackground)`, grouped backgrounds, separator colors, tint, and semantic warning/destructive colors where practical.
  - Keep a deliberate dark appearance if product direction still requires it, but implement it through semantic color choices and environment-aware tokens rather than raw black/white everywhere.
  - Add or update shared button/surface primitives so iOS 26 can use native `.buttonStyle(.glass)` / `.buttonStyle(.glassProminent)` or equivalent `glassEffect` wrappers, with iOS 17 fallbacks.
  - Remove duplicated round-glass icon styling from feature views by routing attachment, expanded composer, permissions, model, send, stop, and thread action buttons through one shared primitive family.
  - Document any remaining hardcoded custom visual choices as product-specific exceptions.
- Delegation:
  - Good subagent slice: a worker can own only `apps/ios/Sources/KodexIOS/UI/*` and static audits while the main agent or another worker handles sidebar/settings.
- Exit criteria:
  - `rg -n "glassEffect\\(|GlassEffectContainer" apps/ios/Sources/KodexIOS/Surfaces apps/ios/Sources/KodexIOS/ConnectionView.swift` finds no direct feature-surface Liquid Glass calls.
  - `rg -n "Color\\(red:|Color\\.white\\.opacity" apps/ios/Sources/KodexIOS/UI apps/ios/Sources/KodexIOS/Surfaces` is either empty or every remaining occurrence is an intentional exception. If this command path is adjusted during implementation, record the exact final static audit command in the implementation summary.
  - XcodeBuildMCP `build_sim` for scheme `KodexIOS` passes.

### 2. Native Sidebar Shell, Navigation Chrome, And Search

- Scope: `WorkspaceDrawerView.swift`, `WorkspaceDrawerComponents.swift`, `ConnectionView.swift`, `KodexIOSUITests.swift`.
- Work:
  - Replace the sidebar `ScrollView`/nested `VStack` shell with `List(selection:)` or the closest native `List` structure that preserves Pinned, Projects, and Chats content.
  - Move `Kodex` title and create-chat action into `navigationTitle` and `.toolbar` where possible.
  - Replace `WorkspaceSearchField` with `.searchable(text:placement:)`, keeping a stable accessibility hook for fixture tests if SwiftUI exposes one reliably.
  - Replace manual footer background/hairline with a native toolbar item, settings row, or `safeAreaInset(edge: .bottom)` using `.background(.bar)`.
  - Preserve compact `NavigationStack` back swipe and regular-width `NavigationSplitView` behavior introduced in `ConnectionView`.
  - Preserve refresh behavior through native `.refreshable`.
- Delegation:
  - Good subagent slice after milestone 1: a worker can own `WorkspaceDrawerView.swift`, header/search/footer parts of `WorkspaceDrawerComponents.swift`, and the connected/offline/auth UI tests. Avoid parallel edits to `KodexRows.swift` until milestone 3 starts.
- Exit criteria:
  - The connected fixture still shows workspace content, gateway status, create-chat affordance, Pinned/Projects/Chats access, and settings access.
  - `testConnectedFixtureRendersWorkspaceAndThreadDetail`, `testOfflineFixtureRendersEmptyWorkspace`, `testAuthRequiredFixtureRendersRecoveryState`, `testCompactThreadCanSwipeBackToSidebar`, and `testFixtureUsesSplitNavigationOnRegularWidthDevices` pass or are intentionally updated for native accessibility names.
  - XcodeBuildMCP screenshots are captured for connected drawer, offline drawer, and auth/settings entry.

### 3. Native Scope, Sections, Project Rows, And Thread Row Actions

- Scope: `KodexRows.swift`, `WorkspaceDrawerView.swift`, `WorkspaceDrawerComponents.swift`, `KodexIOSUITests.swift`.
- Work:
  - Replace `KodexSegmentedScopeControl` with `Picker("Scope", selection: $scope).pickerStyle(.segmented)` or a native toolbar/menu alternative if the sidebar `List` makes segmented scope awkward.
  - Replace `KodexDisclosureRow` and `drawerSection(...)` with native `Section`, `DisclosureGroup`, or hierarchical `List` patterns.
  - Replace thread rows as full-row `Button` containing `Menu` with native row content plus `NavigationLink`/selection, `.swipeActions`, and `.contextMenu` or a separate trailing action that does not alter the row's primary accessibility role.
  - Keep pin, archive, approval, active, unread, and selected indicators available, but express them as row labels/badges/accessibility values rather than nested controls when possible.
  - Preserve project collapse, project-thread creation, pinned filtering, chat filtering, and selected thread routing.
- Delegation:
  - Good subagent slice: after milestone 2 stabilizes the list shell, a worker can own row/section primitives and project/thread rows while another worker handles settings or composer.
- Exit criteria:
  - Simulator accessibility inspection no longer reports thread rows as pop-up buttons solely because of nested menus.
  - Sidebar scope switching, search filtering, section expand/collapse, row selection, pin, and archive are covered by UI tests or a documented simulator checklist.
  - Connected and degraded fixture UI tests pass.

### 4. Native Settings Form

- Scope: `ConnectionSettingsSheet` in `WorkspaceDrawerComponents.swift` or a new `Surfaces/Workspace/ConnectionSettingsSheet.swift`, `KodexIOSUITests.swift`.
- Work:
  - Replace the settings `ScrollView`/custom card groups with `Form`.
  - Use `Section` for Profile, Gateway, and Notifications.
  - Use `LabeledContent` for read-only status rows and native `TextField` for gateway URL.
  - Add `.keyboardType(.URL)`, URL text content traits, submit behavior where appropriate, and native disabled/loading affordances for refresh/notification registration.
  - Keep `Done`, account state, gateway status, check connection, editable gateway URL, and enable notifications behavior.
- Delegation:
  - Highly parallelizable: a worker can own the settings sheet files and related settings UI tests independently of sidebar rows and thread/composer work.
- Exit criteria:
  - `testAuthRequiredFixtureRendersRecoveryState` passes or is updated for intentional native `Form` accessibility changes.
  - A focused settings UI test verifies editing the gateway URL field remains possible.
  - XcodeBuildMCP screenshot confirms the settings sheet reads as a native grouped settings form.

### 5. Native Composer Selection And Keyboard Focus

- Scope: `ThreadComposerBar.swift`, `ThreadDetailView.swift`, `KodexComposerPrimitives.swift`, `KodexButtons.swift`, `KodexIOSUITests.swift`.
- Work:
  - Convert model, reasoning, approval policy, and sandbox choices from plain menu buttons to picker-style selections inside menus or sheets where possible.
  - Preserve compact icon affordances, but make current selection available through native picker state, labels, or accessibility values.
  - Keep `PhotosPicker` as the direct native attachment entry.
  - Replace `UIApplication.shared.sendAction` keyboard dismissal in `ThreadDetailView` with `@FocusState`-driven focus management.
  - Keep expanded composer sheet behavior, disabled/enabled send behavior, Stop behavior, and existing composer payload routing unchanged.
- Delegation:
  - Good subagent slice after milestone 1: a worker can own composer controls and focus state. Coordinate with milestone 6 if shared glass/composer primitives are still moving.
- Exit criteria:
  - `testComposerControlsRemainAccessibleInFixtures` and `testConnectedFixtureRendersWorkspaceAndThreadDetail` pass or are updated for intentional native picker accessibility.
  - Menus/pickers expose the selected model/reasoning/permission choices accessibly.
  - Composer keyboard dismissal works by focus state in the connected fixture.

### 6. Thread Detail, Timeline, And Status Surface Cleanup

- Scope: `ThreadDetailView.swift`, `TimelineRowView.swift`, `ThreadActionMenu.swift`, `ThreadStatusCards.swift`, shared card/surface primitives, relevant UI tests.
- Work:
  - Keep the compact thread detail on native navigation bar/back-swipe behavior.
  - Move thread action menu label chrome to shared native/glass button primitives.
  - Refactor approval and queued-input cards onto shared status/form-like button rows where native controls make sense.
  - Split timeline rendering into role-aware primitives such as `TimelineMessageBubble` and `TimelineStatusRow`.
  - Replace title-string role inference in `TimelineRowView` with normalized metadata if current iOS models already expose enough data; otherwise document the model gap and keep the heuristic isolated.
  - Preserve bottom-entry, follow-scroll, jump-to-bottom, older-history sentinel, text selection, and timeline row identifiers.
- Delegation:
  - Parallelizable with settings/sidebar once shared primitives settle. A worker can own `Surfaces/Thread/*` except `ThreadComposerBar.swift` if milestone 5 is active.
- Exit criteria:
  - Existing timeline, approval, queued input, jump-to-latest, Stop, and thread action UI tests pass.
  - Degraded fixture screenshot confirms approval flows remain clear and native controls are not visually buried.
  - No gateway state ownership moves into timeline-only SwiftUI state.

### 7. Root State And Presentation Extraction

- Scope: `ConnectionView.swift`, potential new `ConnectionModel.swift` or `ConnectionCoordinator.swift`, focused unit tests.
- Work:
  - Extract root state and app actions from `ConnectionView` into a `@MainActor @Observable` model where practical for iOS 17+.
  - Keep `ConnectionView` focused on shell composition, navigation choice, and passing model actions to views.
  - Consider enum-backed route/presentation state for compact thread navigation, connection settings, rename, and expanded composer if it simplifies modal ownership.
  - Keep gateway-owned lifecycle truth intact: selected thread detail, approvals, queued inputs, stream checkpoints, and composer settings still come from gateway/app-server reads and live updates.
  - Make service construction injectable enough for focused tests without broad dependency framework work.
- Delegation:
  - Do not run this in parallel with milestones that heavily edit `ConnectionView`. Start after sidebar/settings/thread composition milestones have landed, or give a worker exclusive ownership of `ConnectionView` and the new model files.
- Exit criteria:
  - `ConnectionView.swift` is materially smaller and mostly declarative.
  - Focused tests cover route selection, sidebar/detail presentation, and at least one action path such as archive, composer send, or notification route using injected services or fixtures.
  - Existing live smoke still runs through the same gateway endpoints and state ownership boundaries.

### 8. Native Accessibility And Dynamic Type Pass

- Scope: All changed iOS views and `KodexIOSUITests.swift`.
- Work:
  - Audit accessibility roles after replacing custom controls with native controls using XcodeBuildMCP `snapshot_ui`.
  - Add or preserve accessibility identifiers only where tests need stable hooks; prefer native labels/values for user-facing semantics.
  - Verify Dynamic Type does not clip key controls in sidebar rows, segmented scope, settings form, thread toolbar, composer, approval cards, and jump-to-bottom.
  - Confirm 44 pt tap target behavior remains for toolbar/action controls.
- Delegation:
  - Good review-agent slice: a subagent can run a read-only accessibility/screenshot audit after implementation milestones land.
- Exit criteria:
  - Snapshot output shows rows, search, segmented picker, settings controls, composer menus, and thread actions with native roles.
  - UI tests avoid brittle implementation-specific queries when native labels are enough.

### 9. Full Verification, Screenshots, And Live Smoke

- Scope: Build/test scripts, simulator runs, screenshots, plan/index updates.
- Work:
  - Run package and simulator verification:
    - `cd apps/ios && swift test`
    - XcodeBuildMCP `build_sim` for `apps/ios/KodexIOS.xcodeproj`, scheme `KodexIOS`
    - XcodeBuildMCP `test_sim` for `KodexIOS` on iPhone
    - XcodeBuildMCP `test_sim` for the iPad split navigation test on an iPad simulator when practical
  - Run optional live smoke when a ready authenticated gateway is available:
    - `KODEX_GATEWAY_URL=http://127.0.0.1:8787 apps/ios/scripts/run-live-e2e.sh`
  - Capture screenshots for:
    - connected workspace drawer;
    - connected thread detail/composer;
    - degraded approval state;
    - settings form;
    - offline empty state;
    - iPad split view when practical.
  - Update `plans/index.md` status when implementation starts/completes.
- Delegation:
  - Good final review slice: a subagent can independently review the diff against this plan and run a subset of tests/screenshots while the main agent handles any fixes.
- Exit criteria:
  - All required checks pass or skipped live checks are documented with reasons.
  - Screenshots are saved as local review artifacts or linked if the implementation convention requires it.
  - Independent review finds no major native-control regressions.

## Parallelization Map

- Parallel after milestone 1:
  - Settings `Form` work can proceed independently from composer and most sidebar row work.
  - Composer picker/focus work can proceed independently from settings and row work.
  - Thread timeline/status cleanup can proceed independently from settings after shared primitives settle.
- Sequential or coordinated:
  - Sidebar shell/search should land before row/section replacement to avoid conflicts in `WorkspaceDrawerView.swift`.
  - Root state extraction should wait until surface churn slows down, because it touches the same callbacks and navigation wiring every milestone uses.
  - Native accessibility and screenshot review should run after major surface changes, not before.
- Suggested subagent ownership:
  - Worker A: `UI/*` native theme/glass/button foundation.
  - Worker B: workspace sidebar shell/search/sections/rows.
  - Worker C: settings form.
  - Worker D: thread composer and focus.
  - Worker E: thread timeline/action/status surfaces.
  - Worker F: final review/a11y/screenshot audit.

## Verification

- Static audits:
  - `rg -n "glassEffect\\(|GlassEffectContainer" apps/ios/Sources/KodexIOS`
  - `rg -n "Color\\(red:|Color\\.white\\.opacity|RoundedRectangle\\(|Capsule\\(" apps/ios/Sources/KodexIOS/Surfaces`
  - `rg -n "UIApplication\\.shared|UIDevice\\.current|UIScreen|UserDefaults\\.standard" apps/ios/Sources/KodexIOS`
- Package and simulator:
  - `cd apps/ios && swift test`
  - XcodeBuildMCP `build_sim` for `apps/ios/KodexIOS.xcodeproj`, scheme `KodexIOS`
  - XcodeBuildMCP `test_sim` for focused fixture tests during each milestone
  - XcodeBuildMCP full `test_sim` before completion
- UI inspection:
  - XcodeBuildMCP `snapshot_ui` on connected drawer and thread detail to confirm native roles.
  - XcodeBuildMCP screenshots for changed drawer, settings, composer, approval, empty, and split-view surfaces.
- Optional live:
  - `KODEX_GATEWAY_URL=http://127.0.0.1:8787 apps/ios/scripts/run-live-e2e.sh` when gateway/auth state permits.

## Risks And Open Questions

- Native controls will change spacing, roles, backgrounds, and some visuals. This is intentional for this plan; do not treat contact-sheet mismatch as a blocker unless a workflow becomes worse.
- SwiftUI `.searchable` accessibility identifiers can be awkward in UI tests. Prefer user-facing labels in tests, but keep a stable hook if needed.
- `List(selection:)` and `NavigationStack`/`NavigationSplitView` interactions can be subtle across compact and regular width. Preserve compact back-swipe and iPad split coverage.
- Settings `Form` may make custom dark styling less prominent. Accept this unless readability, local/VPN gateway warning clarity, or URL entry suffers.
- Root state extraction is high-blast-radius. It should be done after visible native-control milestones unless implementation proves that navigation/sheet state is too tangled to proceed safely.
- Timeline message role inference from title text is brittle. If current gateway/iOS models lack a stronger role field, isolate the heuristic and consider a separate API/model plan rather than widening this native-control plan.
