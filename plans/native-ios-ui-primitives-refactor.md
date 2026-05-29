# Native iOS UI Primitives Refactor Plan

Status: Complete as of 2026-05-29.

## Context

Refactor the native iOS app so future UI work is built from a shared Kodex SwiftUI primitive layer instead of repeating local colors, radii, glass modifiers, row chrome, cards, and composer controls inside feature surfaces. This follows the generated design-system contact sheet at [artifacts/ios-design-system/kodex-ios-liquid-glass-design-system-contact-sheet.png](../artifacts/ios-design-system/kodex-ios-liquid-glass-design-system-contact-sheet.png) and builds on the completed [Native iOS UX Parity Plan](native-ios-ux-parity.md) and [Native iOS Contact Sheet Polish Plan](native-ios-contact-sheet-polish.md).

The goal is not a new visual redesign or gateway behavior change. The goal is to make the existing dark OLED / iOS 26 Liquid Glass direction maintainable by turning repeated UI shapes into named primitives and semantic components, then documenting that future iOS features must use or extend those primitives.

Relevant code seams:

- `apps/ios/Sources/KodexIOS/UI/KodexTheme.swift` owns the current colors, radii, row height, and icon/composer sizing tokens.
- `apps/ios/Sources/KodexIOS/UI/KodexGlassSupport.swift` owns `KodexGlassCluster`, `KodexGlassSurface`, `.kodexGlass(...)`, `KodexIconButton`, `KodexMenuRow`, `KodexBottomComposerShell`, `KodexStatusDot`, `KodexProfileAvatar`, and `KodexSegmentedScopeControl`.
- `apps/ios/Sources/KodexIOS/Surfaces/WorkspaceDrawerView.swift` owns the drawer shell, search field, section headers, project rows, thread rows, footer, and `ConnectionSettingsSheet`. It is currently about 675 lines and includes reusable-looking views such as `ProjectDrawerSection`, `KodexDisclosureRow`, and `KodexThreadRow`.
- `apps/ios/Sources/KodexIOS/Surfaces/ThreadDetailView.swift` owns the thread header, timeline rows, composer, approvals, queued input cards, and action menu. It is currently about 695 lines and includes reusable-looking views such as `TimelineRowView`, `ComposerBar`, `ApprovalCard`, and `QueuedInputCard`.
- `apps/ios/Sources/KodexIOS/ConnectionView.swift` owns state and service callbacks for the extracted surfaces and should keep gateway-owned behavior unchanged during this refactor.
- `apps/ios/Tests/KodexIOSUITests/KodexIOSUITests.swift` covers connected, degraded, offline, auth-required, composer controls, action menu order, live smoke, and iPad split navigation.
- `apps/ios/README.md` documents XcodeBuildMCP as the preferred build/test/screenshot harness.
- `AGENTS.md` currently has frontend primitive guidance for web/Mantine but no matching native iOS primitive rule.

## Current State

- The iOS app already has a small primitive base in `UI/`, but the layer is thin. It covers theme tokens, glass support, icon buttons, menu rows, the bottom composer shell, status dots, avatars, and a workspace segmented control.
- Several domain components live inside surface files even though they are likely reusable or should at least be clearly owned: `KodexThreadRow`, `KodexDisclosureRow`, `ProjectDrawerSection`, `TimelineRowView`, `ComposerBar`, `ApprovalCard`, `QueuedInputCard`, and `ConnectionSettingsSheet`.
- Local surface code still repeats one-off rounded rectangles, hairline overlays, status colors, capsule controls, composer chips, row spacing, and card backgrounds. The result is workable but makes future UI additions likely to drift from the contact-sheet direction.
- `KodexGlassSupport.swift` mixes generic primitives, data-aware primitives such as `KodexStatusDot`, and workspace-specific primitives such as `KodexSegmentedScopeControl`. This is acceptable for the first pass but should be split as the primitive catalog grows.
- The repository targets iOS 17 while developing against iOS 26 simulators. Any Liquid Glass primitive must remain availability-gated with fallbacks.
- The planned work is styling and component organization first. It should not change generated OpenAPI artifacts, gateway routes, app-server behavior, notification behavior, thread state ownership, or composer command routing.

## Non-Goals

- Do not introduce a separate design-system package or external UI dependency.
- Do not replace SwiftUI-native controls with web-style custom controls when native `Button`, `Menu`, `PhotosPicker`, `TextField`, `TextEditor`, `NavigationSplitView`, and sheets already provide behavior.
- Do not widen gateway DTOs or generated iOS API types for this refactor.
- Do not change fixture data except where tests need clearer coverage of an extracted component.
- Do not make screenshots or generated contact-sheet files part of runtime app assets.

## Milestones

### 1. Define The Primitive Catalog And File Boundaries

- Scope: `apps/ios/Sources/KodexIOS/UI/`, `ThreadDetailView.swift`, `WorkspaceDrawerView.swift`.
- Work:
  - Split the current `KodexGlassSupport.swift` into smaller files without changing behavior, for example:
    - `KodexGlass.swift` for `KodexGlassCluster`, `KodexGlassSurface`, and `.kodexGlass(...)`;
    - `KodexButtons.swift` for `KodexIconButton` and shared circular/chip button styles;
    - `KodexMenus.swift` for `KodexMenuRow` and any shared menu row presentation;
    - `KodexStatus.swift` for `KodexStatusDot`, status color helpers, and `KodexProfileAvatar`;
    - `KodexComposerPrimitives.swift` for `KodexBottomComposerShell`, composer input chrome, composer chips, and send/stop button sizing;
    - `KodexRows.swift` for row shells, disclosure rows, selected row background, unread/pinned/status adornments, and project/thread row layout primitives.
  - Keep `KodexTheme.swift` as the token owner and expand it only for repeated semantic values from the contact sheet: surface opacity, card radius, chip radius, timeline bubble radius, status colors, and composer/control heights.
  - Keep all iOS 26 Liquid Glass calls centralized in primitive files with `#available(iOS 26.0, *)` branches and iOS 17 fallbacks.
  - Add short comments only for availability/fallback intent where the code would otherwise be easy to misuse.
- Exit criteria:
  - `rg -n "glassEffect\\(|GlassEffectContainer" apps/ios/Sources/KodexIOS/Surfaces apps/ios/Sources/KodexIOS/ConnectionView.swift` finds no direct feature-surface Liquid Glass calls.
  - `KodexGlassSupport.swift` is either removed or reduced to reexports/compatibility-level content; generic primitives live in named files under `UI/`.
  - `cd apps/ios && swift test` passes.
  - XcodeBuildMCP `build_sim` for scheme `KodexIOS` passes.

### 2. Extract Drawer Rows, Section Chrome, And Settings Surfaces

- Scope: `WorkspaceDrawerView.swift`, new files under `apps/ios/Sources/KodexIOS/UI/` or `apps/ios/Sources/KodexIOS/Surfaces/Workspace/`.
- Work:
  - Move `KodexDisclosureRow` and the reusable row shell from `WorkspaceDrawerView.swift` into the primitive layer.
  - Extract semantic drawer components with clear ownership:
    - `WorkspaceHeaderView` for the title, status dot, new-chat action, and show-thread action;
    - `WorkspaceSearchField` for search field chrome;
    - `WorkspaceProjectSection` for the folder/disclosure/new-thread project header plus nested thread rows;
    - `WorkspaceThreadRow` or a generic `KodexListRow` specialization for pinned/chat/project thread rows;
    - `WorkspaceFooterView` for avatar, optional short account label, and settings action;
    - `ConnectionSettingsSheet` into its own file if it remains a surface-specific sheet rather than a primitive.
  - Replace local rounded-rectangle backgrounds and strokes with shared row/surface primitives.
  - Preserve accessibility identifiers and labels used by `KodexIOSUITests`, changing tests only where the user-visible component intentionally changes.
  - Keep drawer filtering, project collapse, pin/archive callbacks, and selection routing in `WorkspaceDrawerView` or `ConnectionView`; do not move gateway state into primitives.
- Exit criteria:
  - `WorkspaceDrawerView.swift` is primarily composition and filtering logic, not low-level row drawing.
  - Existing UI tests for connected/degraded/offline/auth-required drawer states pass or are updated for intentional accessibility-name moves.
  - Screenshots of `--fixture-connected`, `--fixture-degraded`, and `--fixture-offline` still match the current dark OLED layout and the contact-sheet row hierarchy.
  - No gateway API, generated OpenAPI, or iOS generated API files change.

### 3. Extract Timeline, Approval, Queue, And Composer Components

- Scope: `ThreadDetailView.swift`, new files under `apps/ios/Sources/KodexIOS/Surfaces/Thread/`, composer primitive files under `UI/`.
- Work:
  - Move `TimelineRowView` into a thread surface file and have it consume shared timeline bubble/status primitives rather than local background and radius logic.
  - Extract `ApprovalCard` and `QueuedInputCard` into named thread surface components, backed by shared status/card primitives for warning, destructive, neutral, and queued states.
  - Split `ComposerBar` into:
    - a semantic `ThreadComposerBar` surface that wires callbacks and data;
    - reusable primitives for composer shell, input pill, metadata chip, attachment button, and send/stop action.
  - Keep `ThreadActionMenu` as a semantic surface component, but make its button/menu row chrome come from shared primitives.
  - Preserve `onSend`, `onStop`, `onSettingsChange`, `PhotosPicker`, skill insertion, local image attachment count, approval decisions, and queued input actions.
  - Keep text selection and long-thread scroll behavior unchanged.
- Exit criteria:
  - `ThreadDetailView.swift` is primarily header, timeline composition, sheet presentation, and callback wiring.
  - Existing UI tests cover timeline rows, approval cards, queued input cards, composer disabled/enabled state, expanded composer, attachment menu, permissions menu, model menu, Stop state, and action menu order.
  - XcodeBuildMCP screenshots for connected and degraded fixture thread detail preserve the current behavior while showing components built from the shared primitive layer.
  - `rg -n "RoundedRectangle\\(|Capsule\\(|\\.stroke\\(KodexTheme\\.hairline|Color\\.white\\.opacity|Color\\(red:" apps/ios/Sources/KodexIOS/Surfaces` shows only feature-specific exceptions that are documented in code review.

### 4. Add Native iOS Primitive Guardrails To `AGENTS.md`

- Scope: `AGENTS.md`, possibly `apps/ios/README.md` if validation guidance changes.
- Work:
  - Add a `Native iOS UI Organization` section to `AGENTS.md` near the existing frontend organization/styling guidance.
  - Document that new SwiftUI UI work under `apps/ios/Sources/KodexIOS` must:
    - start with existing tokens and primitives in `apps/ios/Sources/KodexIOS/UI`;
    - extend the primitive layer when a control, surface, row, chip, badge, card, composer element, status treatment, or glass/material treatment is repeated or defines product-wide chrome;
    - keep semantic feature components under their surface/domain files while delegating repeated visual chrome to primitives;
    - centralize Liquid Glass usage and keep all iOS 26 APIs availability-gated with iOS 17 fallbacks;
    - avoid inline one-off colors, radii, hairline overlays, and button sizing when a token or primitive exists;
    - preserve gateway-owned state boundaries and avoid moving shared lifecycle decisions into SwiftUI-only state;
    - update fixture UI tests and simulator screenshots when changing visible primitive behavior.
  - Add a short note that generated contact sheets are references, not runtime app assets or pixel-perfect specs.
  - Update `apps/ios/README.md` only if the validation workflow changes.
- Exit criteria:
  - `AGENTS.md` contains native iOS primitive guidance that is specific enough for future contributors to follow.
  - The new guidance does not conflict with web/Mantine frontend guidance or existing gateway-owned state rules.
  - `plans/index.md` remains current for this plan's status.

### 5. Verification, Visual Review, And Cleanup

- Scope: iOS tests, simulator build/test, screenshots, dead-code cleanup, plan/index maintenance.
- Work:
  - Run focused static checks for primitive drift:
    - `rg -n "glassEffect\\(|GlassEffectContainer" apps/ios/Sources/KodexIOS`
    - `rg -n "Color\\(red:|Color\\.white\\.opacity|RoundedRectangle\\(|Capsule\\(" apps/ios/Sources/KodexIOS/Surfaces`
  - Run package and simulator verification:
    - `cd apps/ios && swift test`
    - XcodeBuildMCP `build_sim` for `apps/ios/KodexIOS.xcodeproj`, scheme `KodexIOS`
    - XcodeBuildMCP simulator UI tests for scheme `KodexIOS`
  - Capture final fixture screenshots for:
    - connected workspace drawer;
    - connected thread detail;
    - degraded approval detail;
    - offline empty state;
    - auth-required/settings state when practical.
  - Compare against the generated contact sheet for structure, density, token usage, and component consistency rather than pixel-perfect matching.
  - Remove dead private views, duplicate helpers, and unused theme constants after extraction.
- Exit criteria:
  - All required iOS checks pass.
  - Final screenshots show the app still matches the dark OLED / Liquid Glass direction.
  - No generated API artifacts changed.
  - A review pass confirms future UI additions have clear primitive/component homes.

## Verification

- Planning/static:
  - `rg -n "glassEffect\\(|GlassEffectContainer" apps/ios/Sources/KodexIOS` to confirm platform material calls remain centralized in `UI/`.
  - `rg -n "Color\\(red:|Color\\.white\\.opacity|RoundedRectangle\\(|Capsule\\(" apps/ios/Sources/KodexIOS/Surfaces` to audit remaining local chrome.
- Unit/package:
  - `cd apps/ios && swift test`
- Simulator:
  - XcodeBuildMCP `build_sim` for `apps/ios/KodexIOS.xcodeproj`, scheme `KodexIOS`, selected iPhone simulator.
  - XcodeBuildMCP simulator UI tests for `KodexIOS`.
  - Optional live smoke after structural refactor: `KODEX_GATEWAY_URL=http://127.0.0.1:8787 KODEX_IOS_LIVE_E2E=1 apps/ios/scripts/run-live-e2e.sh`
- Visual:
  - XcodeBuildMCP screenshots for fixture drawer, thread detail, approvals, and empty states.
  - Compare screenshots against [artifacts/ios-design-system/kodex-ios-liquid-glass-design-system-contact-sheet.png](../artifacts/ios-design-system/kodex-ios-liquid-glass-design-system-contact-sheet.png) and the acceptance criteria in the prior native iOS polish plan.

## Implementation Summary

- Split the native iOS primitive layer out of `KodexGlassSupport.swift` into focused files for glass, buttons, menus, status/avatar presentation, composer primitives, rows, and cards.
- Moved workspace drawer subcomponents into `Surfaces/Workspace/WorkspaceDrawerComponents.swift`, leaving `WorkspaceDrawerView.swift` focused on composition, filtering, section state, and callback wiring.
- Moved thread detail subcomponents into `Surfaces/Thread/`, including thread action menu, timeline rows, composer bar, approval card, and queued input card.
- Added shared modifiers for composer input chrome, composer chips, status cards, panel surfaces, row backgrounds, and timeline bubbles so feature surfaces no longer repeat most shape/stroke/color chrome.
- Added `Native iOS UI Organization` guidance to `AGENTS.md` requiring future SwiftUI work to use or extend the native primitive layer, centralize Liquid Glass usage, keep iOS 17 fallbacks, and preserve gateway-owned state boundaries.
- Regenerated `apps/ios/KodexIOS.xcodeproj` with XcodeGen after adding new Swift files.
- Re-captured fixture screenshots under `artifacts/ios-design-system/` after the refactor.

## Risks And Open Questions

- The main risk is over-abstracting too early. Extract primitives only when they represent repeated visual chrome or product-wide behavior; keep one-off feature layout in surface files.
- A primitive layer can become a dumping ground if semantic components and generic primitives are not separated. Prefer `UI/` for reusable chrome and `Surfaces/<domain>/` for data-aware feature components.
- SwiftUI `Menu`, `PhotosPicker`, and `TextField` carry platform behavior. Primitive wrapping should not hide or weaken accessibility, focus, keyboard, menu, or photo-picker behavior.
- Some `RoundedRectangle` and `Capsule` usage will remain legitimate inside primitive implementations. The audit should focus on feature surfaces, not banning shapes globally.
- Existing fixture screenshots under `artifacts/ios-design-system/` are useful review references but may not be committed long-term. If the visual reference must be durable, promote the selected contact sheet into `plans/assets/` during implementation.
