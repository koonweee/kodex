# Native iOS Thread And Composer Cleanup Plan

## Context
- Clean up the native iOS workspace drawer, thread detail surface, and composer to better match the intended Kodex mobile UX.
- Relevant code seams:
  - Sidebar rows and project sections in `apps/ios/Sources/KodexIOS/UI/KodexRows.swift`, `apps/ios/Sources/KodexIOS/Surfaces/WorkspaceDrawerView.swift`, and `apps/ios/Sources/KodexIOS/Surfaces/Workspace/WorkspaceDrawerComponents.swift`
  - Thread header, timeline scroll behavior, and thread interactions in `apps/ios/Sources/KodexIOS/Surfaces/ThreadDetailView.swift` and `apps/ios/Sources/KodexIOS/Surfaces/Thread/TimelineRowView.swift`
  - Composer controls and attachment flow in `apps/ios/Sources/KodexIOS/Surfaces/Thread/ThreadComposerBar.swift`, `apps/ios/Sources/KodexIOS/UI/KodexButtons.swift`, and `apps/ios/Sources/KodexIOS/UI/KodexComposerPrimitives.swift`
  - Live photo upload and persisted composer settings in `apps/ios/Sources/KodexIOS/ConnectionView.swift`
  - Fixture/live UI coverage in `apps/ios/Tests/KodexIOSUITests/KodexIOSUITests.swift`

## Current State
- `KodexThreadRow` shows `WorkspaceThread.title`, but its subtitle still falls back to `cwd` or the last path component, which leaks project/folder names into both pinned rows and chats.
- `WorkspaceProjectSection` renders project rows with a selected-row style block and a visible `project.path` subtitle, which makes project rows visually heavier than the surrounding section headers.
- `ThreadDetailView` still renders `detail.thread.cwd` and a status dot in the header, hides the navigation bar globally, and uses a plain `ScrollView` without bottom anchoring, follow-scroll behavior, or a jump-to-bottom affordance.
- `TimelineRowView` still wraps assistant messages in bubbles and only approximates user alignment with spacer math.
- `ThreadComposerBar` hardcodes a narrow model list, keeps text labels on the permissions/model controls, exposes skills under the add menu, and uses 48pt add/send buttons that are taller than the input chrome.
- Attachment selection currently uses `PhotosPicker` inside a `Menu`, while `ConnectionView` depends on `selectedPhotoItem` changes to upload images in live mode.
- `ConnectionSettingsSheet` is presented as a plain sheet without a standard close affordance in its own navigation chrome.

## Milestones

### 1. Sidebar And Settings Surface Cleanup
- Scope: `KodexRows.swift`, `WorkspaceDrawerView.swift`, `WorkspaceDrawerComponents.swift`
- Work:
  - Remove project/folder subtitles from thread rows and make pinned/project/chat row titles consistently use the thread title only.
  - Restyle project rows to read like inset section blocks that visually match the `Projects` and `Pinned` headers rather than selected conversation pills.
  - Remove `project.path` from project rows and simplify the project row structure to an inset header plus nested thread list.
  - Wrap the connection settings sheet in a standard navigation layout with an explicit close/back affordance.
- Exit criteria:
  - Sidebar rows no longer show `cwd`/folder names in subtitles.
  - Project rows no longer use the old filled selected-row background and no longer show directory paths.
  - Settings sheet presents a visible close affordance in simulator UI tests.

### 2. Thread Header And Timeline Behavior Cleanup
- Scope: `ThreadDetailView.swift`, `TimelineRowView.swift`
- Work:
  - Simplify the thread header to show only the thread title plus actions; remove `cwd` and the status dot.
  - Right-align user messages, remove assistant bubbles, and keep non-message/status rows visually distinct.
  - Rework the thread timeline onto a scroll reader driven layout that enters at bottom, follows streaming while the user remains at bottom, and stops auto-following once the user scrolls away.
  - Add a floating jump-to-bottom button when the user is not at the end of the timeline.
  - Dismiss the keyboard when the user taps the chat background.
- Exit criteria:
  - Opening a thread lands at the newest row.
  - Streaming updates auto-follow only when the timeline is already at bottom.
  - User messages are right aligned and assistant messages render without chat bubbles.
  - Simulator/UI tests cover bottom-entry and jump-to-bottom visibility or behavior.

### 3. Composer Controls, Model Options, And Photo Attachments
- Scope: `ThreadComposerBar.swift`, `KodexButtons.swift`, `KodexComposerPrimitives.swift`, `ConnectionView.swift`, relevant tests
- Work:
  - Reduce add/send button size so they match the composer input height more closely.
  - Convert the composer secondary controls to icon-only affordances while preserving current control height and matching the add-button visual language.
  - Expand the hardcoded model list to the intended supported set used by the app.
  - Remove skills from the add menu and make the add control photo-only, with selection invoking the existing live upload flow.
  - Verify the photo selection path updates `selectedPhotoItem` and uploads successfully in live mode, while remaining safe in fixtures.
- Exit criteria:
  - The add menu only offers photo attachment.
  - The add/send buttons are visibly smaller and aligned to the input chrome.
  - Model selection exposes the expected expanded list.
  - Simulator tests still pass and updated attachment/menu assertions match the new UI.

## Verification
- `cd apps/ios && xcodegen generate`
- `xcodebuild -project apps/ios/KodexIOS.xcodeproj -scheme KodexIOS -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build`
- `xcodebuild -project apps/ios/KodexIOS.xcodeproj -scheme KodexIOS -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test`
- Simulator validation on the connected fixture build:
  - Open the workspace drawer and confirm pinned/project/chat rows no longer show folder subtitles.
  - Open a thread and confirm header/title cleanup, user/assistant message layout changes, bottom-entry behavior, keyboard dismissal, and jump-to-bottom affordance.
  - Open composer menus and confirm photo-only add flow plus icon-only control styling.

## Risks And Open Questions
- The desired “other models” set is not currently sourced from the gateway, so the implementation will need a deliberate hardcoded expansion in `ThreadComposerBar.swift` unless a canonical list already exists elsewhere.
- `PhotosPicker` inside `Menu` may be the root cause of the no-op attachment action; if so, the fix should switch to a direct `PhotosPicker` trigger while preserving the current upload path in `ConnectionView.uploadPhoto(_:)`.
- Bottom-follow behavior depends on deriving a stable “near bottom” signal from SwiftUI scroll position; this needs simulator validation because the current timeline is a plain `ScrollView`.
