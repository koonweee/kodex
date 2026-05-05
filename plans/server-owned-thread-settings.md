# Server-Owned Thread Settings Plan

## Scope

Match Codex TUI/app-server resume semantics for model and execution settings in Kodex web. Existing thread composer settings must come from gateway/app-server thread metadata, not browser memory. Draft composer state is local-only and has no durable thread identity until the user sends the first message.

This plan intentionally avoids optimistic per-thread settings overlays. If a create, list, read, or resume response omits thread settings, the UI should expose that missing contract through fallback defaults or tests rather than silently preserving client-only state.

## Principles

- Server owns durable thread execution settings.
- Frontend owns only local draft text, attachments, and draft settings before thread creation.
- Drafts are not threads. A real thread starts only when the user submits the first message.
- No optimistic thread-settings cache.
- Existing-thread composer settings are derived from `ThreadSummary` metadata.
- Gateway responses should be coherent immediately after create/resume/read/list.
- App-server README and checked-in schemas remain the source of truth for upstream behavior.
- OpenAPI DTOs remain the public contract; frontend types must be regenerated from gateway OpenAPI if DTOs change.

## Settings Covered

- `model`
- `reasoningEffort`
- `serviceTier`
- `approvalPolicy`
- `approvalsReviewer`
- `sandbox`
- `cwd` as thread identity/execution context, not as a mutable composer control

## TUI-Aligned Draft Model

- A draft is local composer state only.
- Draft settings use the current selected draft controls or global/project defaults.
- Creating a project thread or chat selects a local draft composer surface, not a persisted thread.
- On first send, the frontend sends draft text and draft settings to the gateway.
- The gateway creates the real thread and returns a coherent `ThreadSummary`.
- Once the thread exists, all composer settings for that thread are derived from returned thread metadata.
- Reloading, opening another browser, or switching devices never depends on draft memory from the first client.

## Non-Goals

- No browser local storage for thread settings.
- No same-session fallback cache for existing threads.
- No durable empty draft threads.
- No handwritten API contract docs.
- No broad composer redesign.
- No change to app-server behavior unless gateway tests prove current upstream responses cannot support the contract.

## Milestone 1: Contract Audit And Failing Tests

Status: Complete

Failing tests first:

- Gateway test: `POST /v1/threads` forwards selected start settings and returns a `ThreadSummary` containing those settings even if app-server returns them at the command-response top level instead of inside `thread`.
- Gateway test: `POST /v1/threads/:threadId/resume` without overrides preserves app-server persisted `model` and `reasoningEffort` in the returned `ThreadSummary`.
- Gateway test: `GET /v1/threads` and `GET /v1/threads/:threadId` normalize thread settings consistently from app-server payloads.
- Frontend test: after a fresh render with no client cache, selecting a thread restores model settings from `/v1/threads` or `/v1/threads/:threadId`.
- Frontend test: switching between two existing threads never leaks the previously selected model when the newly selected thread lacks model metadata.

Implementation:

- Audit app-server schema JSON for thread/list, thread/read, thread/start, and thread/resume fields.
- Audit gateway normalization in `app_server_api.rs`, `events.rs`, and thread routes.
- Identify any field-name drift, especially camelCase versus snake_case and top-level command response fields versus nested `thread` fields.
- Document findings only in this plan if they affect milestone scope.

Exit conditions:

- Tests fail before implementation for every confirmed gap.
- Gaps are classified as gateway normalization gaps, frontend derivation gaps, or app-server upstream limitations.
- No frontend cache behavior is added.

## Milestone 2: Gateway-Owned Thread Settings

Status: Complete

Failing tests first:

- Gateway create response overlays request settings into returned `ThreadSummary` when app-server omits them from nested `thread`.
- Gateway chat-thread creation does the same for `POST /v1/chats/threads`.
- Gateway resume/read/list responses expose persisted thread settings when app-server provides them.

Implementation:

- Normalize all thread settings in one gateway helper.
- For create responses, make the gateway response coherent by overlaying the settings it just sent to app-server if app-server omits them.
- For resume/read/list responses, do not invent missing settings; return what app-server persisted.
- Do not add any gateway concept of a durable draft. The gateway only sees thread creation when the first message is sent or when an explicit thread start is requested.
- Keep `rawPayload` available for diagnostics, but do not require frontend code to inspect it for normal settings.
- Regenerate OpenAPI and frontend API types if Rust DTO shape changes.

Exit conditions:

- Gateway tests pass.
- `/openapi.json` includes the settings fields on relevant thread DTOs.
- Frontend generated schema is current if API artifacts changed.
- Local/VPN-only gateway assumptions remain unchanged.

## Milestone 3: Remove Existing-Thread Client Cache

Status: Complete

Failing tests first:

- Frontend test: created `mini` with `gpt-5.4-mini`, created `spark` with `gpt-5.3-codex-spark`, fresh render from server data restores each model from thread metadata.
- Frontend test: selecting a thread with no model metadata shows the durable default/global setting, not the last selected thread model.
- Frontend test: changing draft settings before first send affects create/start requests but does not create a lasting client-only thread cache.
- Frontend test: selecting a new draft, then cancelling/switching away, leaves no created thread and no per-thread settings entry.

Implementation:

- Remove `threadComposerSettingsById` or reduce it to a pure draft-only mechanism if no existing-thread cases remain.
- Derive selected existing-thread composer settings directly from `selectedThread`.
- Keep `draftComposerSettings` for new project threads and chats before a thread exists.
- Treat draft project threads and draft chats as local composer modes, not thread records.
- On thread create, rely on the gateway response containing coherent settings before inserting the thread into sidebar state.
- On selected-thread snapshot/list/resume updates, replace thread metadata and let derived settings update naturally.

Exit conditions:

- No existing-thread model, reasoning, service tier, or permission settings depend on browser-only cache.
- Same-session switching and fresh-render switching use the same data path.
- Empty draft thread selection does not create or persist a thread.
- Frontend composer settings tests pass.

## Milestone 4: Cross-Device And Reload Coverage

Status: Complete

Failing tests first:

- Component test simulates a second browser by rendering the app with no prior React state and server-returned thread metadata.
- Component test covers delayed selected-thread snapshot after initial list data.
- Optional Playwright flow verifies create two threads, reload, switch back, and observe restored model.

Implementation:

- Add test fixtures for server-owned thread settings.
- Prefer component tests for deterministic state ownership checks.
- Add Playwright only if the behavior needs browser-level verification after component coverage.

Exit conditions:

- Fresh render and reload tests pass.
- Same-session-only cache cannot mask missing server metadata in tests.
- The browser behavior matches Codex TUI resume semantics: existing thread settings come from persisted thread metadata.

## Milestone 5: Cleanup And Documentation

Status: Complete

Implementation:

- Remove dead cache helpers and stale tests that assert client-owned existing-thread settings.
- Update `README.md` only if commands or user-visible setup change.
- Update `AGENTS.md` only if contributor workflow or frontend ownership rules change.
- Keep this plan and [plans/index.md](index.md) current as milestones move.

Exit conditions:

- `cargo test` passes if gateway code changed.
- `cargo fmt` has been run if Rust code changed.
- `cd apps/web && npm test` passes for affected frontend suites.
- `cd apps/web && npm run build` passes.
- Generated OpenAPI/frontend types are updated if the public API changed.
- Independent review pass finds no major ownership or regression issues.
