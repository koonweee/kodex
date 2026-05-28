# Native iOS Contact Sheet Polish Plan

Status: Complete as of 2026-05-28.

## Context

Polish the native iOS app after the first live-gateway smoke showed the thread detail rendering does not yet match the desired product direction. The source-of-truth design reference for this plan is the generated contact sheet at [plans/assets/native-ios-contact-sheet.png](assets/native-ios-contact-sheet.png), created from:

- the live Kodex thread-detail problem screenshot at `/private/tmp/kodex-ios-live-gateway-screenshots/03-live-thread-detail.jpg`;
- the ChatGPT-inspired mobile reference attached in the conversation;
- user feedback that messages should be sleeker, composer colors are currently wrong, the sidebar should reduce connection state to a status dot, notifications copy should be hidden, and profile identity should be a first-initial avatar rather than a full email.

This plan builds on the completed [Native iOS UX Parity Plan](native-ios-ux-parity.md). It is not a broad redesign of gateway behavior or thread state ownership. The implementation should keep using native SwiftUI and existing Liquid Glass primitives while tightening the visual hierarchy against the contact sheet.

Relevant code seams:

- `apps/ios/Sources/KodexIOS/Surfaces/ThreadDetailView.swift` owns the thread header, explicit `Load Older` button, timeline rows, expanded composer sheet, composer shell, approval cards, and queued-input cards.
- `apps/ios/Sources/KodexIOS/Surfaces/WorkspaceDrawerView.swift` owns the drawer header, connection text, Projects/Chats scopes, pinned/project/chat rows, footer account copy, and `ConnectionSettingsSheet`.
- `apps/ios/Sources/KodexIOS/UI/KodexTheme.swift` owns the current OLED palette, panel colors, bubble color, radii, and sizing constants.
- `apps/ios/Sources/KodexIOS/UI/KodexGlassSupport.swift` owns `KodexGlassCluster`, `kodexGlass`, `KodexIconButton`, `KodexBottomComposerShell`, and the segmented scope control.
- `apps/ios/Sources/KodexIOS/ConnectionView.swift` owns callbacks for selection, `loadOlderTimeline()`, composer settings, sending, stopping, and thread actions.
- `apps/ios/Sources/KodexCore/GatewayProbe.swift` provides `ThreadTimeline.olderCursor` and `ThreadTimeline.hasOlder`, which can drive lazy older-history loading without adding gateway state.
- `apps/ios/Tests/KodexIOSUITests/KodexIOSUITests.swift` has fixture coverage for drawer, thread detail, composer, actions, and live smoke.
- `apps/ios/Tests/KodexCoreTests/LiveGatewayServiceTests.swift` covers older timeline page loading and should stay green.

## Current State

- The live thread detail still exposes an explicit `Load Older` button at the top of the timeline. User direction is clear: do not use a load-more button; older history should lazy load or infinite scroll.
- Timeline messages currently show role labels for assistant rows through `shouldShowAuthor`, use a broad body text treatment, and render non-message/status rows as large pill surfaces. This conflicts with the contact sheet direction: compact rounded message bubbles, no visible `User` or `Assistant` labels, subtle thought/activity rows, and clearer left/right message hierarchy.
- `ComposerBar` wraps the controls in a large `KodexBottomComposerShell` with a light gray glass tray effect, separate underbar text, and multiple chips. The desired direction is a ChatGPT-like dark pill composer: near-black input, circular plus, muted mic/control affordances, bright circular send/voice action, and secondary metadata kept compact.
- The drawer header currently shows `connection.displayText`, which can be a full `Connected to http://127.0.0.1:8787` line. The requested target is a minimal green/yellow/red status dot near `Kodex`, with full gateway diagnostics moved to settings.
- The drawer footer currently shows `accountState.displayText` and `notificationStatus`. The target is a profile avatar with first initial, no full email, and no visible notifications-enabled copy.
- `ConnectionSettingsSheet` has a dedicated `Notifications` group showing `notificationStatus`. The target is to hide notifications-enabled text from settings; notification controls may remain only if actionable and not as a status readout.
- The app already has centralized theme and glass primitives, so the main work is refinement and composition rather than introducing a new UI stack.

## Design Acceptance Criteria

- The implemented iOS screens must visually match [plans/assets/native-ios-contact-sheet.png](assets/native-ios-contact-sheet.png) for structure, density, palette, and control hierarchy.
- OLED black remains the base. Composer and message surfaces use near-black and charcoal colors, not large bright gray trays.
- Thread messages render without visible role labels such as `User` and `Assistant`.
- User messages use compact right-aligned rounded bubbles. Assistant messages read as clean left-aligned text or subtle bubbles. Thought/activity/status rows are muted and compact.
- The composer is a dark rounded pill system with compact circular controls and safe-area-aware placement. It must not cover timeline content or use the current oversized light-gray slab treatment.
- Sidebar connection state is represented by a small status dot. Full gateway URL/status text is available only in settings or diagnostics, not the normal drawer header.
- Sidebar footer shows a circular profile avatar with first initial only. It must not show the full email address.
- Notifications-enabled/status copy is hidden from the normal drawer and settings. Any notification action should be phrased as an action, not a persistent status line.
- Older history loads lazily as the user scrolls near the top of the timeline. There is no visible `Load Older` or `Load More` button in the final UI.

## Milestones

### 1. Stabilize Design Tokens And Contact-Sheet Primitives

- Scope: `KodexTheme.swift`, `KodexGlassSupport.swift`, and any small primitive files under `apps/ios/Sources/KodexIOS/UI/`.
- Work:
  - Tune theme colors to match the contact sheet: OLED black base, near-black composer/input surfaces, charcoal message bubbles, subtle borders, white text, muted secondary text, and small green/yellow/red status accents.
  - Add or refine primitives for:
    - circular profile avatar with first initial;
    - compact status dot with accessibility label;
    - dark pill input container;
    - compact metadata/chip row for model and permissions;
    - muted thought/activity row styling.
  - Keep Liquid Glass usage gated with `#available(iOS 26.0, *)` in existing primitive style, preserving iOS 17 fallback behavior.
  - Avoid scattering literal colors/radii in `ThreadDetailView.swift` and `WorkspaceDrawerView.swift`; prefer `KodexTheme` and shared modifiers.
- Exit criteria:
  - New/tuned primitives compile without changing gateway APIs or generated OpenAPI artifacts.
  - `ThreadDetailView.swift` and `WorkspaceDrawerView.swift` can consume the primitives without local one-off color constants.
  - Visual review of the primitives against the contact sheet confirms the composer base is dark, not light gray.

### 2. Redesign Thread Timeline And Lazy Older-History Loading

- Scope: `ThreadDetailView.timeline`, `TimelineRowView`, `ConnectionView.loadOlderTimeline()`, fixture data in `GatewayConfiguration.swift` if needed, and UI tests.
- Work:
  - Remove the visible `Load Older` button and `LoadOlderTimeline` accessibility target from the timeline.
  - Add lazy top-of-scroll loading using a sentinel row or top `onAppear` trigger that calls `onLoadOlder` when `detail.timeline.hasOlder` and `olderCursor` are present.
  - Add an in-flight guard in `ConnectionView` or `ThreadDetailView` so repeated sentinel appearances do not issue duplicate page loads for the same cursor.
  - Preserve the existing page merge behavior in `ConnectionView.loadOlderTimeline()` and keep `ThreadTimeline.olderCursor` as the source of truth for more history.
  - Restyle `TimelineRowView` to match the contact sheet:
    - no visible role labels for ordinary user or assistant messages;
    - compact right-aligned user bubbles;
    - assistant content left-aligned with either no heavy background or a subtle dark surface;
    - thought/work/status rows as muted inline rows with optional chevron, not large `completed` pills;
    - warning/error/tool/file rows compact enough not to dominate the chat transcript.
  - Ensure long assistant responses remain readable, selectable, and clear of the composer safe-area inset.
- Exit criteria:
  - No `Load Older` or `Load More` button is present in fixture or live thread detail UI.
  - A fixture with `hasOlder: true` triggers one older-page callback when the user scrolls to the top, with duplicate-load protection.
  - Existing `LiveGatewayServiceTests.liveGatewayServiceLoadsOlderTimelineWithCursor` remains passing.
  - `KodexIOSUITests.testConnectedFixtureRendersWorkspaceAndThreadDetail` is updated to validate the sleeker row hierarchy and absence of `User`/`Assistant` labels.
  - Simulator screenshot of the thread surface visually matches the `Thread` panel in the contact sheet.

### 3. Rebuild The Composer To Match The Contact Sheet

- Scope: `KodexBottomComposerShell`, `ComposerBar`, expanded composer sheet in `ThreadDetailView`, and composer UI tests.
- Work:
  - Replace the current large gray composer tray with a dark, compact bottom system:
    - circular `+` attachment button;
    - near-black rounded text input pill with muted placeholder;
    - optional mic/voice-style icon affordance if it can be mapped to existing behavior without adding a fake feature;
    - bright circular send button when text is sendable;
    - compact stop button state for active threads.
  - Keep permissions/model controls available, but tuck them into a compact metadata row or menu treatment that does not make the composer look like a settings panel.
  - Keep expanded compose using the same palette and header controls instead of default bright sheet styling.
  - Ensure disabled send and busy states remain obvious without washing out the composer.
  - Preserve existing callbacks: `onSend`, `onStop`, `onSettingsChange`, `PhotosPicker`, skills insertion, and local image attachment count.
- Exit criteria:
  - Composer background no longer appears as a large light-gray slab in simulator screenshots.
  - Composer controls fit in iPhone portrait without clipping or overlapping the keyboard safe area.
  - UI tests cover send disabled/enabled state, stop state, expanded composer, attachment menu existence, and model/permissions menu access.
  - Simulator screenshot visually matches the `Composer` panel in the contact sheet.

### 4. Polish Sidebar Header, Footer, And Settings Identity

- Scope: `WorkspaceDrawerView.header`, `WorkspaceDrawerView.footer`, `ConnectionSettingsSheet`, account/status presentation helpers, and UI tests.
- Work:
  - Replace the header connection text with a small status dot near the `Kodex` title. The dot color should derive from `GatewayConnectionStatus`.
  - Keep full connection diagnostics reachable from `ConnectionSettingsSheet`, but do not show the full gateway URL in the normal drawer header.
  - Replace footer account/status text with:
    - circular profile avatar using first initial from account display/email when available;
    - optional short display label only if it is not a full email;
    - gear/settings button.
  - Hide `notificationStatus` from the drawer footer.
  - Remove the settings `Notifications` status group or rework it so it does not show `Notifications enabled` / `Notifications not enabled` as persistent copy. If an enable action remains, show it only when useful and without a status readout.
  - Keep accessibility labels explicit because visual status text is being removed.
- Exit criteria:
  - Drawer header has a status dot and no `Connected to http://...` visible text.
  - Drawer footer has no full email and no notification status text.
  - Settings sheet has no persistent notifications-enabled copy.
  - UI tests cover the new `GatewayStatusDot`, profile avatar first initial, settings access, and absence of full email/status text in normal fixture UI.
  - Simulator screenshot visually matches the `Projects` and `Settings` panels in the contact sheet.

### 5. Live Smoke, Screenshot Review, And Plan Closeout

- Scope: simulator validation, screenshots, docs/index updates when implementation starts/completes.
- Work:
  - Run the fixture simulator suite and live gateway smoke against `http://127.0.0.1:8787`.
  - Capture final iPhone screenshots for:
    - live chats/sidebar;
    - live projects/sidebar;
    - live thread detail;
    - composer focused/keyboard state if practical;
    - settings sheet.
  - Compare each screenshot against [plans/assets/native-ios-contact-sheet.png](assets/native-ios-contact-sheet.png) and the design acceptance criteria above.
  - Update `apps/ios/README.md` only if the settings/connection flow or validation commands change.
  - Update `plans/index.md` status when implementation starts and when it completes.
- Exit criteria:
  - `cd apps/ios && swift test` passes.
  - XcodeBuildMCP `build_sim` passes for scheme `KodexIOS`.
  - XcodeBuildMCP `test_sim` passes for the selected iPhone simulator.
  - Live smoke passes with `KODEX_GATEWAY_URL=http://127.0.0.1:8787 KODEX_IOS_LIVE_E2E=1 apps/ios/scripts/run-live-e2e.sh`.
  - Final screenshots are saved and linked in the implementation summary.
  - A reviewer can verify there is no visible load-more button, no normal-surface full gateway URL, no normal-surface full email, no notifications-enabled copy, and composer/message visuals match the contact sheet.

## Verification

- Static/code:
  - `rg -n "Load Older|Load More|LoadOlderTimeline" apps/ios/Sources apps/ios/Tests` should find no final visible button text or active accessibility target.
  - `rg -n "notificationStatus|Notifications enabled|Notifications not enabled" apps/ios/Sources/KodexIOS` should show no normal drawer/settings status readout after the cleanup.
- Unit/package:
  - `cd apps/ios && swift test`
- Simulator:
  - XcodeBuildMCP `build_sim` for `apps/ios/KodexIOS.xcodeproj`, scheme `KodexIOS`.
  - XcodeBuildMCP `test_sim` on the selected iPhone simulator.
  - Live smoke: `KODEX_GATEWAY_URL=http://127.0.0.1:8787 KODEX_IOS_LIVE_E2E=1 apps/ios/scripts/run-live-e2e.sh`
- Visual:
  - Capture XcodeBuildMCP screenshots for sidebar, thread detail, composer, and settings.
  - Compare against [plans/assets/native-ios-contact-sheet.png](assets/native-ios-contact-sheet.png), using the acceptance criteria in this plan rather than pixel-perfect matching.

## Risks And Open Questions

- SwiftUI lazy top-sentinel loading can fire repeatedly during layout changes. The implementation needs a cursor/in-flight guard so older history is not fetched multiple times.
- `TimelineRow` currently exposes normalized `title`, `body`, and `kind`, but not every rich rendering detail from the web timeline. This plan should polish what the iOS model already has before widening gateway DTOs.
- The contact sheet includes a mic/voice-like composer affordance inspired by ChatGPT. If no real voice action exists, use an existing action or omit the icon rather than adding a fake control.
- Hiding full email requires deriving a stable first initial from `KodexAccountState.displayText` or adding a small account presentation helper. Avoid storing new profile state locally.
- Notifications should not disappear as functionality if already supported. The requested change is to hide status copy, not remove gateway notification APIs or action paths.
