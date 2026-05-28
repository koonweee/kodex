# Native iOS UX Parity Plan

Status: Complete as of 2026-05-28.

## Context

Bring the native iOS app closer to the current Kodex web mobile experience for the three highest-priority surfaces:

- mobile workspace/thread navigation;
- selected-thread timeline and composer hierarchy;
- selected-thread action menu.

The web app is the UX source of truth for behavior, density, information hierarchy, and control availability. The iOS implementation should stay SwiftUI-native and should not embed the web app or recreate React/Mantine internals. On iOS 26 and newer, custom chrome should use native Liquid Glass primitives (`glassEffect`, `GlassEffectContainer`, and glass button styles) with sensible pre-iOS-26 fallbacks. Start with shared iOS UI primitives so the parity work does not keep expanding `ConnectionView.swift`.

Relevant code seams:

- `apps/ios/Sources/KodexIOS/ConnectionView.swift` currently owns the root split navigation, gateway controls, workspace list, thread detail, timeline rows, composer bar, approvals, queued inputs, and action menu in one file.
- `apps/ios/Sources/KodexCore/GatewayProbe.swift` owns iOS view models such as `WorkspaceSnapshot`, `WorkspaceProject`, `WorkspaceThread`, `ThreadDetail`, `ThreadTimeline`, and `TimelineRow`.
- `apps/ios/Sources/KodexAPI/LiveGatewayService.swift` already wraps generated OpenAPI operations for sidebar snapshots, thread detail, composer settings, pin/unpin, rename, archive, notifications, Stop, queue, approvals, and skills.
- `apps/ios/Tests/KodexIOSUITests/KodexIOSUITests.swift` has fixture UI coverage for connected, degraded, offline, auth-required, thread detail, approvals, and live smoke.
- `apps/web/src/threads/WorkspaceSidebar.tsx`, `apps/web/src/threads/sidebarRows.tsx`, and `apps/web/src/threads/ThreadPanel.tsx` are the web source for mobile sidebar structure, row/action behavior, thread header, and overflow actions.
- `apps/web/src/composer/InlineComposerPanel.tsx` and `apps/web/src/composer/ComposerToolbar.tsx` are the web source for the rounded mobile composer, attachment control, permission/model controls, Stop/Send behavior, and project/branch underbar.

## Current State

- iOS uses `NavigationSplitView(preferredCompactColumn:)`, but the compact iPhone workspace is a default SwiftUI `List` with gateway setup controls ahead of thread navigation. This differs from the web mobile drawer, which starts with search, new-thread controls, a Projects/Chats segmented scope, pinned rows, project groups, and account/settings footer.
- iOS `ThreadDetailView` renders a standard light SwiftUI navigation screen with `.navigationTitle`, a top `Stop` button, a text `Actions` menu, material cards, and a `.bar` composer. The web mobile detail uses a dark Kodex visual system, compact header, icon actions, rich text/code rendering, and a persistent rounded composer shell with attachment, permissions, model/effort, send/stop, and context underbar controls.
- iOS thread actions currently include `Rename`, notification toggle, and `Archive` from `ThreadDetailView.toolbar`. Web thread actions include pin/unpin, rename, notifications with an inline switch, and archive, in that order, from `ThreadPanel.tsx`.
- iOS has the required service operations for this scope. The parity gap is mainly presentation, view decomposition, and fixture/UI coverage, not gateway API availability.
- Existing native plans say the app should remain a native client, not a wrapped web app. This plan interprets "web as source of truth" as UX parity in native SwiftUI, not DOM/CSS reuse.
- The current iOS app does not use Liquid Glass APIs. Existing material/card styling should be replaced or wrapped by primitives that use Liquid Glass on iOS 26+ and fallback materials on earlier supported iOS versions.

## Non-Goals

- Automations, Project Settings, MCP manager, plugin installation, and project preview parity are out of scope for this plan.
- Approval-card parity is out of scope except for keeping approval and queued-input rows compatible with the new thread detail layout.
- Running Codex locally on device, public gateway auth, and production APNs delivery remain out of scope.
- A UIKit timeline engine is out of scope unless SwiftUI profiling shows a concrete problem.
- Hand-rolled blur/glass effects are out of scope where native Liquid Glass APIs can express the design.

## Milestones

### 1. Shared Native UI Primitives And File Boundaries

- Scope: new Swift files under `apps/ios/Sources/KodexIOS/`, plus focused extraction from `ConnectionView.swift`.
- Work:
  - Add a small SwiftUI primitive layer, for example:
    - `KodexTheme.swift` for dark color, spacing, typography, radius, and icon sizing constants;
    - `KodexGlassSupport.swift` for `#available(iOS 26, *)` helpers, shared glass shapes, tints, and fallback material definitions;
    - `KodexSurface.swift` or `KodexGlassSurface.swift` for card/panel backgrounds using `.glassEffect(..., in:)` on iOS 26+ and `.ultraThinMaterial` or restrained solid surfaces on older iOS;
    - `KodexIconButton.swift` for square icon actions with accessibility labels, using `.buttonStyle(.glass)` or `.glassEffect(.regular.interactive(), in:)` where appropriate;
    - `KodexMenuRow.swift` for icon + label menu rows;
    - `KodexSegmentedScopeControl.swift` for Projects/Chats-style selection;
    - `KodexDisclosureRow.swift` and `KodexThreadRow.swift` for reusable sidebar rows;
    - `KodexBottomComposerShell.swift` for the rounded composer container used by compact and expanded composer states.
  - Wrap groups of adjacent glass controls in `GlassEffectContainer`, especially header actions, segmented scope controls, sidebar rows with trailing actions, composer controls, and action-menu groups.
  - Apply `glassEffect` after layout and appearance modifiers, keep glass shapes consistent within each surface, and use `.interactive()` only for tappable/focusable elements.
  - Gate all Liquid Glass APIs with `#available(iOS 26, *)`; preserve the app's existing iOS 17 deployment target with fallback styling.
  - Split existing private views out of `ConnectionView.swift` into feature files:
    - workspace/sidebar views;
    - thread detail and timeline views;
    - composer views;
    - thread action menu views.
  - Keep state ownership in `ConnectionView` for this milestone unless extracting a store is necessary for a clean boundary.
  - Avoid introducing app-wide abstractions that do not serve these three surfaces.
- Exit criteria:
  - `ConnectionView.swift` no longer owns all low-level view definitions for the three target surfaces.
  - The extracted primitives compile in the app target without changing gateway behavior.
  - Liquid Glass use is centralized in primitives rather than scattered across feature views.
  - iOS 26+ and fallback paths are both visible in code review.
  - Existing fixture UI tests still pass or are updated only for intentional accessibility-label changes.
  - Verification commands:
    - `cd apps/ios && swift test`
    - XcodeBuildMCP build/test on scheme `KodexIOS` for the selected iPhone simulator.

### 2. Mobile Workspace Drawer Parity

- Scope: iOS workspace/sidebar views, `WorkspaceSnapshot` presentation helpers, fixture data, and UI tests.
- Work:
  - Replace the compact iPhone `List` workspace with a custom dark workspace drawer matching the web mobile structure:
    - top search field;
    - new chat icon action;
    - close/show-thread icon action when a thread is selected;
    - Projects/Chats segmented scope;
    - collapsible Pinned section;
    - collapsible Projects section;
    - project rows with folder icon, disclosure affordance, settings action, and new-thread action;
    - project thread rows with pin/unpin affordance and status/unread/approval cues where iOS models expose them;
    - Chats section when the Chats scope is active;
    - account/settings/footer area without putting gateway diagnostics ahead of thread navigation.
  - Use `GlassEffectContainer` for the search/new-thread/close header cluster and Projects/Chats segmented scope, with interactive glass only on the controls.
  - Use glass surfaces for the mobile drawer footer and high-emphasis grouped controls, but keep dense thread rows legible and scannable; do not make every text row a heavy glass card.
  - Preserve gateway-owned state:
    - thread selection still comes from `selectedThreadID`;
    - unread/pinned/notification state still comes from `WorkspaceThread`;
    - thread creation, pin/unpin, archive, and mark-seen still route through `LiveGatewayService`.
  - Move gateway URL/check-connection controls into a secondary settings/connection surface for iPhone so they do not dominate normal thread browsing.
  - Keep iPad `NavigationSplitView` behavior, but reuse the same row primitives so iPad and iPhone do not diverge unnecessarily.
  - Add fixture coverage for search, Projects/Chats switching, project collapse, pinned rows, and selected-thread return.
- Exit criteria:
  - iPhone fixture launch opens to a web-like thread browser, not a gateway setup form.
  - Selecting a chat or project thread pushes/shows the thread detail and marks it seen through the existing live path.
  - UI tests cover Projects scope, Chats scope, Pinned, search filtering, and the show-thread/close path.
  - Manual validation captures iOS simulator screenshots for the drawer and compares them against the saved web mobile baseline from the previous UX pass.

### 3. Thread Detail And Composer Hierarchy Parity

- Scope: iOS thread detail, timeline row presentation, composer views, composer settings controls, and UI tests.
- Work:
  - Rebuild the selected-thread detail as a dark Kodex surface with:
    - compact top header;
    - icon-only sidebar/back affordance;
    - truncated title matching the web header hierarchy;
    - overflow action button;
    - scrollable timeline region that keeps content clear of the composer;
    - bottom composer anchored above the safe area.
  - Use Liquid Glass for floating chrome that benefits from platform material behavior:
    - header icon controls;
    - overflow action button;
    - persistent composer shell;
    - attachment/permissions/model/send control group;
    - expanded composer sheet toolbar controls.
  - Avoid applying Liquid Glass to every timeline row. Timeline content should remain readable and stable; use subtle surfaces for message/tool/file rows and reserve glass for interactive or floating controls.
  - Update timeline row styling to match the web hierarchy more closely:
    - user/assistant message distinction;
    - compact activity/tool/file rows;
    - readable monospace blocks for commands and code-like text;
    - copy affordances where the current data model supports message/code text.
  - Rebuild `ComposerBar` around the shared rounded composer shell:
    - placeholder `type clever thing here`;
    - leading attachment `+` menu;
    - permissions preset control;
    - model/effort control;
    - send/stop icon button;
    - project/branch underbar when available from iOS models;
    - expanded compose sheet using the same primitives.
  - Use `GlassEffectContainer` inside `KodexBottomComposerShell` so composer controls blend/morph as the compact composer expands or changes between send and stop states.
  - Keep submit/stop/settings behavior backed by existing `LiveGatewayService` calls and `ComposerRunSettings`.
  - Keep queued-input and approval rows visible in the new timeline stack without treating them as durable local truth.
- Exit criteria:
  - Existing connected fixture still renders all timeline row families and long-thread rows without overlap.
  - Composer UI tests cover compact composer, expanded composer, settings menu, Send disabled/enabled state, and Stop visibility for an active fixture.
  - Manual simulator screenshots show the iOS thread detail and composer matching the web mobile information hierarchy.
  - XcodeBuildMCP screenshot validation is included for narrow iPhone and, where available, iPad split-view shapes.

### 4. Thread Action Menu Parity

- Scope: `ThreadDetailView` action menu, sidebar row swipe/context actions, `LiveGatewayService` action calls, and tests.
- Work:
  - Replace the current text `Actions` menu with an icon overflow button using `KodexIconButton`.
  - Prefer native SwiftUI menu and button Liquid Glass styling over custom popover blur; use the platform menu presentation when it already adopts Liquid Glass.
  - Implement menu rows in web order:
    - Pin thread or Unpin thread;
    - Rename thread;
    - Notifications with a switch-like trailing state;
    - Archive thread.
  - Keep the notification row interactive without dismissing the menu before state feedback if SwiftUI supports it cleanly; otherwise document the native limitation and refresh state immediately after the toggle.
  - Keep swipe actions on thread rows for quick pin/unpin and archive, but make the overflow menu the canonical selected-thread action surface.
  - Ensure destructive archive behavior clears or reroutes selection consistently with the existing `archiveThread(_:)` path.
- Exit criteria:
  - UI tests cover pin/unpin, rename validation/save, notification toggle label/state, and archive removal/reroute in fixture or live-stubbed mode.
  - Live service tests already covering `pinThread`, `renameThread`, `archiveThread`, and `setThreadNotifications` remain passing; add focused tests only if presentation needs new routing helpers.
  - Manual simulator screenshot shows the action menu matching the web menu order and affordance set.

## Verification

- Code and unit:
  - `cd apps/ios && swift test`
  - XcodeBuildMCP `build_run_sim` for `apps/ios/KodexIOS.xcodeproj`, scheme `KodexIOS`, selected iPhone simulator.
  - XcodeBuildMCP simulator UI tests for `KodexIOS` after each behavior-changing milestone.
- UX evidence:
  - Re-capture the web mobile baseline with `$agent-browser` or Playwright at an iPhone-sized viewport for:
    - thread drawer;
    - thread detail/composer;
    - thread action menu.
  - Capture matching iOS simulator screenshots with XcodeBuildMCP.
  - Compare information hierarchy, visible controls, safe-area behavior, touch target density, and Liquid Glass placement, not pixel-perfect CSS.
  - On an iOS 26 simulator, verify glass effects render on intended chrome. On an older supported simulator or fallback code path, verify surfaces remain legible without Liquid Glass.
- Multi-client state:
  - For thread actions and composer state, verify iOS mutates gateway-owned state and converges after a web client or another iOS client changes pin, rename, archive, notification, read state, active turn, or queued input state.
- Documentation:
  - Update `apps/ios/README.md` if the normal launch surface, settings/connection location, or simulator validation commands change.
  - Keep `plans/index.md` status current when implementation starts or completes.

## Implementation Summary

- Added shared SwiftUI primitives for Kodex dark surfaces, Liquid Glass/fallback wrappers, icon buttons, menu rows, segmented scope controls, disclosure rows, thread rows, and the bottom composer shell.
- Replaced the compact iPhone workspace `List` with a custom dark drawer for search, new chat, Projects/Chats scopes, pinned rows, project groups, approval cues, and footer settings.
- Moved thread detail, timeline rows, composer, action menu, approval, and queued-input presentation out of `ConnectionView.swift`.
- Updated thread detail to use a compact header, overflow action menu ordered as Pin/Unpin, Rename, Notifications, Archive, and a Liquid Glass composer shell with Send/Stop tied to thread live state.
- Updated iOS UI fixtures to cover the drawer, idle composer Send state, connection settings, and action-menu labels. Live gateway service tests continue to cover pin, rename, archive, and notification operations.
- Verified with `swift test`, XcodeBuildMCP simulator build, XcodeBuildMCP simulator UI tests, screenshots, and an independent review pass with no major findings.

## Risks And Open Questions

- `ConnectionView.swift` is currently a large mixed-responsibility file. The first milestone must keep extraction mechanical and focused, or parity work will be hard to review.
- Web timeline rendering has richer Markdown/code/file affordances than the current iOS `TimelineRow` view model exposes. Implement what the existing iOS models carry first; widen iOS view models only when generated gateway data already supports it.
- SwiftUI `Menu` may not perfectly match web's non-closing notification switch row. If the native control cannot preserve the menu while toggling, prefer reliable native behavior and immediate visual convergence over custom UIKit menu plumbing.
- The previous native plans intentionally avoid a web clone. This plan resolves that by copying UX structure and behavior from web while keeping native SwiftUI implementation details.
- Liquid Glass can reduce readability if overused on dense timelines and thread lists. The plan intentionally applies it to floating chrome, grouped controls, and high-emphasis surfaces first.
- Liquid Glass APIs require iOS 26+. The repository currently targets iOS 17, so every primitive that calls these APIs must include an availability gate and fallback.
