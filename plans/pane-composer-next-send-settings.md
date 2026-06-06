# Pane Composer Next-Send Settings Plan

## Status

Complete.

## Context

- Workspace thread panes currently render model, reasoning effort, and Fast controls through `ThreadPaneComposerBridge` in `apps/web/src/App.tsx`.
- The current pane fallback uses the App shell's selected-thread `composerSettings` as `composerDefaults`, so changing one active pane can update unrelated pane composers.
- Existing-thread picker changes also call `PATCH /v1/threads/{threadId}/settings` immediately, which matches a thread-default mutation model rather than the desired next-send model.
- Desired behavior: composer settings are pending options for the next submitted message. Picker changes must stay local to the composer/pane until send, including duplicated panes for the same thread; the send request carries the effective settings.

## Current State

- `useComposerSettingsState` in `apps/web/src/composer/useComposerSettingsState.ts` owns selected-thread and durable default settings for the single selected-thread shell.
- `ThreadPaneComposerBridge` in `apps/web/src/App.tsx` has local draft and thread override state, but receives `composerDefaults={composerSettings}` from the selected shell at `renderWorkspaceThreadComposer`.
- Existing-pane setting changes call `updateThreadSettings(...)` from `handleComposerSettingsChange`, causing immediate gateway/app-server thread settings mutation.
- `useComposerOrchestration` in `apps/web/src/composer/useComposerOrchestration.ts` only includes turn options for existing-thread sends when `selectedThreadComposerOverride` is non-null.
- The gateway `PATCH /v1/threads/{threadId}/settings` route remains useful for explicit thread-default/self-control settings, but ordinary composer picker changes should not call it.

## Milestones

### 1. Lock The Regression With Focused Tests

- Scope: `apps/web/src/workspace/ThreadPaneComposerBridge.test.tsx` and nearby composer settings test utilities.
- Work:
  - Add a multi-pane regression test where thread A starts with `high`, thread B changes to `xhigh`, and thread A still displays `high`.
  - Assert ordinary pane picker changes do not call `PATCH /v1/threads/{threadId}/settings`.
  - Add a send-path assertion that the submitted `/input` request includes the effective pane settings.
- Exit criteria:
  - The new test fails on current code before implementation.

### 2. Make Pane Composer State Local Until Submit

- Scope: `ThreadPaneComposerBridge` in `apps/web/src/App.tsx`.
- Work:
  - Replace selected-shell defaults with stable durable defaults for pane fallback, instead of passing selected-thread effective settings as `composerDefaults`.
  - Keep draft settings keyed by pane instance and existing-thread pending settings keyed by pane identity within the pane bridge lifecycle.
  - Seed existing-thread settings from `composerSettingsFromThread(thread)` when gateway metadata is available.
  - Preserve draft-created thread settings as the materialized thread's initial pane settings when canonical metadata is not yet available.
  - Remove the immediate `updateThreadSettings(...)` call from ordinary pane composer setting changes.
- Exit criteria:
  - Pane composer setting changes affect only that pane's local pending send settings.
  - Gateway canonical metadata still updates the pane composer when `paneState.thread` changes.

### 3. Send Effective Settings With Message Submission

- Scope: `apps/web/src/composer/useComposerOrchestration.ts` and its callers.
- Work:
  - Make existing-thread send and queued-input paths use `composerTurnOptions(composerSettings)` for the effective pane settings.
  - Keep draft-thread creation and first send using the draft settings already passed through `onCreateDraftThread`.
  - Ensure no full thread settings object is persisted as future browser-owned thread defaults.
- Exit criteria:
  - New and existing-thread sends carry the model, effort, and Fast options selected in that composer.
  - Picker changes without submit do not mutate the gateway.

### 4. Verification And Review

- Scope: focused frontend tests and review loop.
- Work:
  - Run the focused workspace/composer tests.
  - Run relevant broader frontend verification if focused changes pass.
  - Use an independent review pass against this plan and the user request.
  - Browser validation is optional here because the behavior is state/request routing rather than layout, responsive rendering, or input modality; use component tests as the primary evidence unless implementation changes visible layout.
- Exit criteria:
  - Focused tests pass.
  - Broader frontend check selected for the touched files passes or has a documented blocker.
  - Review reports no major issues.

## Verification

- `cd apps/web && npm test -- ThreadPaneComposerBridge`
- `cd apps/web && npm test -- App.mvp.composer-settings`
- `cd apps/web && npm run build`
- `./tools/trim-frontend.sh` or `cd apps/web && npm run trim` before push-sized completion, documenting any unrelated pre-existing findings.

## Risks And Open Questions

- Existing plans describe app-server-owned thread settings for selected-thread setting changes. This plan narrows ordinary workspace composer picker changes to next-send semantics; explicit thread default/self-control settings should keep using gateway-owned thread settings routes.
- Same thread in two panes should converge when gateway metadata changes, but a local unsent picker change in one pane is intentionally a pending composer edit and should not immediately affect the other pane.
