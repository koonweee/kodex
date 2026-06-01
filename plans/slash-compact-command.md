# Slash Compact Command Plan

## Status

Active.

## Goal

Support TUI-aligned `/compact` from the Kodex web composer. Typing `/` should use a reusable trigger-menu abstraction shared with the existing `$skill` selector, and submitting `/compact` should call gateway-owned compaction instead of sending slash text to the model.

## Non-Goals

- Do not implement `/clear` in this plan.
- Do not implement every upstream slash command. The trigger/menu abstraction should make more commands possible, but only `/compact` is in scope.
- Do not render raw app-server compaction notifications directly in React. Browser-visible timeline state must continue to flow through gateway-owned thread view snapshots and patches.
- Do not let the browser decide shared command routing from local active-turn state.

## Current Kodex Grounding

- `apps/web/src/composer/ComposerPanel.tsx` owns current `$skill` popup state, keyboard handling, and catalog filtering around `draftState.skillToken`.
- `apps/web/src/composer/useComposerDraftState.ts` detects and stores only skill mention tokens; it does not have a generic trigger-token model.
- `apps/web/src/composer/SkillMentionPopup.tsx` and `apps/web/src/composer/MobileSkillCommandSheet.tsx` duplicate the same listbox mechanics for desktop and mobile skill suggestions.
- `apps/web/src/composer/useComposerOrchestration.ts` treats composer submits as normal `UserInput[]` and posts through `submitThreadInput`.
- `apps/gateway/src/routes/turns.rs` owns gateway-safe selected-thread input routing, including active-thread queueing and current-turn interrupt routing.
- `apps/gateway/src/app_server_api.rs` already wraps app-server thread, turn, account, model, skill, and settings requests, but has no `thread/compact/start` helper yet.
- `apps/gateway/app-server-schema/0.135.0/json/ClientRequest.json` includes `thread/compact/start` with `ThreadCompactStartParams { threadId }`.
- `apps/gateway/app-server-schema/0.135.0/json/ServerNotification.json` includes deprecated `thread/compacted`; checked-in v2 schemas also include first-class `contextCompaction` thread items.
- `apps/gateway/src/thread_view.rs` already projects `contextCompaction` rows and prunes missing live compaction markers from canonical snapshots.
- `apps/gateway/src/turn_lifecycle.rs`, `apps/gateway/src/queue.rs`, and `apps/gateway/src/store.rs` hold gateway-owned runtime state used to keep multi-client routing correct.
- `apps/web/src/timeline/presentation.ts` already presents context compaction rows as timeline feedback.

## Upstream TUI Reference

Use the checked-in app-server schema as the wire contract and upstream TUI as behavior guidance.

- Upstream `SlashCommand` presents `Compact` with description "summarize conversation to prevent hitting the context limit" and marks it unavailable while a task is running: https://raw.githubusercontent.com/openai/codex/main/codex-rs/tui/src/slash_command.rs
- Upstream slash dispatch rejects unavailable commands during an active task before dispatching.
- Upstream `/compact` clears token usage, sets task-running UI state if needed, then sends the app compaction event rather than submitting text as a user prompt: https://raw.githubusercontent.com/openai/codex/main/codex-rs/tui/src/chatwidget/slash_dispatch.rs
- Core compaction is a synthesized compaction task, not a normal user-message turn: https://github.com/openai/codex/blob/main/codex-rs/core/src/compact.rs

## UX Contract

- Typing `/` at the beginning of the composer, or after leading whitespace only, opens a command menu.
- Typing after `/` filters command items by command token and description.
- The `/compact` row shows a compact command label and description. It is disabled when there is no selected materialized thread or when the gateway/frontend knows the selected thread is busy.
- Arrow keys move selection, `Enter` or `Tab` selects the active command, and `Escape` closes the menu.
- Selecting `/compact` inserts `/compact ` or keeps `/compact` staged; pressing submit with exactly `/compact` executes compaction.
- Unknown slash text such as `/foo` should not silently go to the model when it is a command-shaped first token. It should produce a clear command error.
- Slash commands should not interfere with `$skill` mentions in ordinary prompt text.
- The desktop popup and mobile sheet should share the same listbox semantics and keyboard/index state as the skill selector.

## Ownership Model

- Frontend owns only ephemeral command discovery, filtering, and menu selection state.
- Gateway owns command execution and shared lifecycle transitions.
- App-server owns the actual compaction operation through `thread/compact/start`.
- Gateway thread view remains the browser contract for timeline and live-state convergence.

## Milestones

### 1. Backend Compaction Contract

Scope: `apps/gateway/src/app_server_api.rs`, `apps/gateway/src/routes/turns.rs`, `apps/gateway/src/api.rs`, generated OpenAPI, and gateway route tests in `apps/gateway/src/routes/mod.rs`.

Work:

- Add `CodexClient::thread_compact_start(thread_id: String) -> ApiResult<RawAppServerResponse>` that sends `thread/compact/start` with `{ threadId }`.
- Add `POST /v1/threads/{threadId}/compact`, returning a typed response such as `ThreadCompactResponse { disposition, rawPayload }`.
- Validate selected-thread state through gateway-owned runtime/thread-view state. If a task is active or starting, return a clear `409` or typed busy disposition instead of queueing compaction.
- On accepted compact start, record gateway runtime state as busy/syncing and emit a `thread_view.patch` lifecycle update so every tab disables conflicting actions.
- Add the new route and response schema to OpenAPI and regenerate `apps/web/src/api/generated/schema.ts`.

Exit criteria:

- A failing-first route test proves `/compact` calls app-server `thread/compact/start` with the selected thread id.
- A route test proves active/busy threads reject compaction and do not call app-server.
- A route test proves accepted compaction emits or exposes a selected-thread syncing lifecycle patch.
- `cargo fmt`
- Focused `cargo test` for route and app-server API coverage.
- `cd apps/web && npm run generate:api` after a gateway with the new OpenAPI route is available.

### 2. Compaction Event Convergence

Scope: `apps/gateway/src/events.rs`, `apps/gateway/src/thread_view.rs`, `apps/gateway/src/thread_view/tests.rs`, `apps/gateway/src/events/tests.rs`, and related replay logic.

Work:

- Audit current handling for `thread/compacted`, `contextCompaction`, `item/started`, `item/completed`, and `turn/completed` around manual compaction.
- Normalize deprecated `thread/compacted` as a refetch or canonical thread-view update signal; prefer canonical `contextCompaction` item projection when app-server emits item snapshots.
- Mark gateway runtime state idle when compaction reaches a terminal state or when a canonical thread read shows no active compaction/task.
- Preserve existing `thread_view.refresh_required` semantics as a refetch signal, not a row source.
- Ensure queue draining remains blocked while compaction is syncing and resumes after idle convergence.

Exit criteria:

- Backend tests cover `thread/compacted` and/or context-compaction item ingestion leading to canonical thread-view convergence.
- Queue/runtime tests prove normal composer input is not routed into a thread while manual compaction is active.
- Existing context-compaction pruning tests continue to pass.
- Focused `cargo test thread_view` and relevant route/event tests pass.

### 3. Generic Composer Trigger Menu

Scope: `apps/web/src/composer/useComposerDraftState.ts`, `apps/web/src/composer/skillMentions.ts`, `apps/web/src/composer/ComposerPanel.tsx`, `apps/web/src/composer/InlineComposerPanel.tsx`, `apps/web/src/composer/MobileComposerPanel.tsx`, `apps/web/src/composer/SkillMentionPopup.tsx`, `apps/web/src/composer/MobileSkillCommandSheet.tsx`, and composer tests.

Work:

- Introduce a generic trigger-token model for composer text, for example `ComposerTriggerToken { trigger, start, end, query }`.
- Extract desktop and mobile suggestion rendering into shared generic components, while keeping skill-specific icon and metadata rendering available through item renderers.
- Convert `$skill` autocomplete to a `skill` provider using the generic trigger menu without changing submitted skill binding behavior.
- Add a `/` command provider that supports start-of-composer command tokens only.
- Keep active index clamping, document pointer closing, keyboard navigation, and mobile sheet behavior in one shared hook or small set of helpers.
- Avoid moving broad composer responsibilities into `App.tsx`.

Exit criteria:

- Existing skill autocomplete tests still pass with no user-visible regression.
- New unit tests cover generic trigger-token detection for `$` and `/`, including leading whitespace, mid-sentence slash text, and escape cases.
- Component tests prove the same keyboard/menu behavior works for skill and slash providers.
- `cd apps/web && npm test -- composer`

### 4. Frontend Slash Command Dispatch

Scope: `apps/web/src/composer/slashCommands.ts`, `apps/web/src/api/client.ts`, `apps/web/src/composer/useComposerOrchestration.ts`, `apps/web/src/App.mvp.composer-input.test.tsx`, and nearby composer component tests.

Work:

- Add generated-client wrapper `compactThread(threadId: string)` around `POST /v1/threads/{threadId}/compact`.
- Add command metadata for `/compact` with label, token, description, disabled reason, and execution kind.
- In composer submit handling, intercept exact `/compact` before building normal `UserInput[]`.
- Clear the composer draft only after the compact command is accepted by the gateway.
- Surface gateway busy/failure errors through the existing `onError` path without creating optimistic user messages.
- Leave text like `Please run /compact later` as ordinary prompt text.

Exit criteria:

- Frontend tests prove `/compact` opens from `/`, filters from `/co`, dispatches `compactThread`, and does not call `submitThreadInput`.
- Frontend tests prove unknown first-token slash commands show a clear error and are not submitted as model text.
- Frontend tests prove ordinary slash text inside a sentence still submits normally.
- `cd apps/web && npm test -- App.mvp.composer-input`
- `cd apps/web && npm run build`

### 5. Browser And Multi-Client Validation

Scope: full-stack behavior across the gateway, web client, selected-thread SSE, and canonical timeline projection.

Work:

- Validate desktop fine-pointer behavior: slash menu opens, keyboard selection works, `/compact` starts compaction, composer disables while syncing, and context-compaction feedback appears or the selected thread refetches cleanly.
- Validate narrow/touch behavior: mobile expanded composer shows the slash command sheet without overlapping the textarea or footer.
- Validate two browser tabs on the same selected thread: one tab starts `/compact`; the other observes the busy/syncing state and cannot start conflicting input until gateway convergence marks idle.
- Confirm selected-thread Stop behavior remains routed through `interrupt-current` and is not reused for compaction unless app-server exposes a specific compaction interrupt contract.

Exit criteria:

- Use `$agent-browser` to smoke the desktop composer slash menu, mobile composer slash sheet, and two-tab convergence path.
- No console errors during browser validation.
- Context-compaction timeline row rendering remains readable and non-overlapping.
- Existing selected-thread SSE recovery behavior still works after a missed compaction event by refetching the thread detail snapshot.

## Verification

- `cargo fmt`
- Focused backend tests for app-server API, route behavior, runtime state, event convergence, and queue blocking.
- `cargo test` before marking the implementation complete.
- Regenerate OpenAPI and `apps/web/src/api/generated/schema.ts` when the gateway route is added.
- Focused frontend unit/component tests for trigger token parsing, skill regression, slash command dispatch, and mobile sheet rendering.
- `cd apps/web && npm test`
- `cd apps/web && npm run build`
- `$agent-browser` desktop, narrow, touch/mobile, and two-tab validation for the browser-observable slash menu and compaction lifecycle.

## Risks And Open Questions

- App-server may emit different event shapes for local versus remote compaction. Treat `thread/compact/start` response plus checked-in schema as the contract, and keep thread-detail refetch as the convergence fallback.
- Manual compaction may not provide a stable active turn id. Gateway busy state should not pretend it can steer or interrupt compaction as an ordinary turn.
- If app-server returns success before any compaction item appears, the UI needs a clear syncing state that resolves through event convergence or bounded refetch.
- `/compact` availability for draft threads is intentionally out of scope; it should require a materialized selected thread.
