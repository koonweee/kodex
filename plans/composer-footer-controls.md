# Composer Footer Controls Plan

## Scope

Add Codex-style composer footer controls for model selection, reasoning effort, inference speed, permissions mode, and context usage display. The web UI should mirror the current Codex TUI/app semantics where practical while staying grounded in the checked-in app-server schema.

This plan covers the composer footer toolbar and the gateway contract needed to forward selected turn settings. It does not add a selectable context-window size, a slash-command framework, or a full settings page.

## Status

Complete.

## Source Mapping

The implementation should follow the Codex TUI behavior verified against upstream Codex source and the checked-in app-server schema:

- Model options come from `model/list`, exposed in Kodex as `GET /v1/models`.
- Reasoning effort comes from each model's `supportedReasoningEfforts` and is forwarded as `turn/start.effort`.
- Fast mode maps to `serviceTier: "fast"`.
- Non-fast/default speed should omit `serviceTier`. Do not treat `serviceTier: "flex"` as the normal/default mode.
- Context usage is display-only and comes from `thread/tokenUsage/updated` using `tokenUsage.total.totalTokens` plus `tokenUsage.modelContextWindow`.
- Permissions modes mirror Codex TUI presets:
  - `Default permissions`: `approvalPolicy: "on-request"`, `approvalsReviewer: "user"`, workspace-write permissions.
  - `Full access`: `approvalPolicy: "never"`, `approvalsReviewer: "user"`, disabled sandbox / danger-full-access permissions.
  - `Auto review`: `approvalPolicy: "on-request"`, `approvalsReviewer: "auto_review"`, workspace-write permissions.

For the pinned local app-server schema, Kodex can forward these as legacy-compatible `sandboxPolicy` values:

- Workspace-write permissions: `{ "type": "workspaceWrite", "networkAccess": false, "writableRoots": [] }`
- Full access: `{ "type": "dangerFullAccess" }`

If a future app-server schema exposes first-class `permissions` / `permissionProfile` request fields, prefer that canonical profile shape over legacy `sandboxPolicy`.

## Principles

- Red first where behavior changes: backend forwarding and frontend interaction both need focused tests before implementation.
- Keep defaults conservative: untouched composer controls should preserve app-server defaults by omitting optional overrides.
- Match Codex vocabulary: use `Default permissions`, `Full access`, `Auto review`, and `Fast`.
- Avoid duplicate DTOs: frontend request/response types must continue to come from regenerated OpenAPI artifacts.
- Keep the toolbar compact: footer controls must not compete with the message field or primary send/stop action.
- Keep local/VPN assumptions explicit if any copy describes permissions or full access.

## Current Problem

The current composer footer supports attachments and send/stop, but it does not expose the turn settings users expect from the Codex app:

- Model and reasoning effort cannot be changed from the composer.
- Fast mode cannot be toggled from the model selector.
- Permissions mode cannot be selected before a turn.
- Context usage is not visible while a thread grows.
- The gateway `turn/start` wrapper forwards only `input`, so selected model, effort, speed, and permissions cannot reach app-server.

## Milestone 1: Gateway Turn Options Contract

Status: Complete

Failing tests first:

- `POST /v1/threads/:threadId/turns` forwards `model` when present.
- It forwards `effort` when present.
- It forwards `serviceTier: "fast"` when present.
- It forwards `approvalPolicy`, `approvalsReviewer`, and `sandboxPolicy` when present.
- It omits optional override fields when the request leaves them unset.

Implementation:

- Extend `TurnStartRequest` with optional `model`, `effort`, `serviceTier`, `approvalPolicy`, `approvalsReviewer`, and `sandboxPolicy`.
- Update the app-server API wrapper so `turn/start` builds a JSON payload from `threadId`, `input`, and only the override fields that are present.
- Keep `turn/steer` unchanged unless app-server explicitly supports equivalent overrides for steering.
- Add `ToSchema` coverage so `/openapi.json` reflects the new optional fields.

Exit conditions:

- Gateway tests verify the exact `turn/start` JSON sent to app-server.
- `cargo fmt` and relevant gateway tests pass.
- OpenAPI generation includes the optional composer setting fields.

## Milestone 2: Draft Thread Start Settings

Status: Complete

Failing tests first:

- Starting from a draft thread preserves selected model and speed on `thread/start`.
- The first submitted turn on the new thread uses compatible selected settings.
- Unsupported first-thread settings are intentionally omitted instead of being sent in invalid shapes.

Implementation:

- Extend `createThread` request handling to accept initial composer settings that `thread/start` supports: `model`, `serviceTier`, `approvalPolicy`, `approvalsReviewer`, and compatible sandbox/permission setting.
- For schema 0.128.0, thread lifecycle requests use legacy `sandbox`; map:
  - Default / Auto review workspace-write to `sandbox: "workspace-write"`.
  - Full access to `sandbox: "danger-full-access"`.
- Keep reasoning effort on the subsequent `turn/start`, because the pinned `ThreadStartParams` does not expose `effort`.

Exit conditions:

- Draft-thread submission applies the selected settings without requiring a second user action.
- Generated OpenAPI and frontend types represent the request shape.
- No handwritten TypeScript gateway DTOs are added.

## Milestone 3: Composer Toolbar State and Model Popover

Status: Complete

Failing tests first:

- The model selector loads and renders visible models from `GET /v1/models`.
- Selecting a model updates the composer footer label.
- Reasoning options are derived from the selected model's `supportedReasoningEfforts`.
- Selecting an effort updates the label and next turn payload.
- Fast mode toggles `serviceTier: "fast"` and shows a `Zap` / lightning icon before the model label.
- Turning Fast off omits `serviceTier`.

Implementation:

- Add a focused composer toolbar component instead of expanding inline footer JSX in `App.tsx`.
- Store composer settings in `KodexShell` state so draft-thread creation and turn submission can both use them.
- Fetch models through the existing generated client wrapper.
- Nest reasoning effort and speed controls inside the model selector popover.
- Use lucide icons for the fast indicator and toolbar affordances.

Exit conditions:

- Model, effort, and speed selections are reflected in outgoing API calls.
- Fast mode display matches Codex convention: lightning icon appears only when `serviceTier: "fast"` is active.
- Existing composer send, stop, attachment, queued steer, and image behavior still pass.

## Milestone 4: Permissions Preset Popover

Status: Complete

Failing tests first:

- The permissions control renders `Default permissions`, `Auto review`, and `Full access`.
- Selecting `Default permissions` prepares `on-request`, `user`, and workspace-write settings.
- Selecting `Auto review` prepares `on-request`, `auto_review`, and workspace-write settings.
- Selecting `Full access` prepares `never`, `user`, and danger-full-access settings.
- Full access uses distinct visual treatment and warning copy in the popover.

Implementation:

- Add a compact permissions trigger in the left side of the composer footer.
- Use Codex TUI labels and payload mappings from this plan's source mapping.
- Keep an internal "unset/default from server" state only for untouched startup if needed; once the user explicitly chooses `Default permissions`, send the explicit Codex TUI default preset.
- Disable or annotate unsupported choices if gateway requirements reject them in a future config endpoint.

Exit conditions:

- The selected permissions preset is visible in the toolbar.
- Turn start payloads include the mapped permission fields.
- Full access is hard to select accidentally and clearly communicates its local-machine implications.

## Milestone 5: Context Usage Indicator

Status: Complete

Failing tests first:

- A `thread/tokenUsage/updated` event updates context usage state for the matching thread.
- The composer footer renders a compact ring/pie indicator when `modelContextWindow` is available.
- Hovering or focusing the indicator shows percent left, used tokens, and context window tokens.
- Missing `modelContextWindow` renders a muted unknown state without crashing.

Implementation:

- Track latest token usage by selected thread from the existing event stream and replay path.
- Compute used context from `tokenUsage.total.totalTokens` initially, unless the event payload later exposes a more precise context-window token count.
- Compute percent left as `100 - used / modelContextWindow`.
- Render an accessible compact visual indicator in the right side of the footer near model/speed.

Exit conditions:

- Context usage updates live as app-server events arrive.
- The indicator is display-only and does not imply a selectable context window.
- The footer remains stable on narrow desktop and mobile widths.

## Milestone 6: Contract Generation and Regression Pass

Status: Complete

Failing tests first:

- Existing MVP Playwright composer flow still submits and clears messages.
- Component tests cover model, speed, permissions, and context usage interactions.
- API client tests or typed call sites fail until regenerated OpenAPI types match the backend.

Implementation:

- Regenerate frontend OpenAPI types after backend DTO changes.
- Update frontend API wrappers for `createThread` and `startTurn` to accept optional composer settings.
- Add CSS for toolbar density, popover layout, active states, and mobile wrapping.
- Verify no toolbar text overlaps or resizes fixed controls unexpectedly.

Exit conditions:

- `cargo fmt` passes.
- Relevant `cargo test` coverage passes.
- `cd apps/web && npm test` passes.
- `cd apps/web && npm run build` passes if TypeScript or production bundle behavior changed.
- `cd apps/web && npm run test:e2e` runs if toolbar behavior affects existing Playwright composer flows.
- README updates are added only if user-visible setup, commands, or security assumptions change.
