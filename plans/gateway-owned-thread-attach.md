# Gateway-Owned Thread Attach Plan

## Status

Complete.

## Context

Thread selection currently lets the browser decide when to call `POST /v1/threads/{threadId}/resume` from list status. Profiling showed selected-thread resume calls costing about 370-390 ms, even when a same-gateway client may already have the thread live. The goal is to move the attach/resume decision into the gateway while preserving the product expectation that selecting `active` or `notLoaded` threads attaches for live updates.

Relevant seams:

- `apps/web/src/App.tsx`
  - selected-thread attach effect
  - `selectedThreadShouldAttachLive`
  - `attachedThreadIdsRef` / `attachingThreadIdsRef`
- `apps/web/src/timeline/useSelectedThreadTimeline.ts`
  - selected snapshot load and selected-thread SSE stream startup
  - current `isSelectedThreadNotLoaded` early return
- `apps/web/src/api/client.ts` and `apps/web/src/api/generated/schema.ts`
  - generated OpenAPI-backed thread client methods
- `apps/gateway/src/routes/threads.rs`
  - existing `resume_thread` route
  - new attach route and response DTOs
- `apps/gateway/src/thread_view.rs`
  - gateway-owned live projection state and active/live checks
- `apps/gateway/src/store.rs`
  - existing `thread_runtime_state` for idle/draining knowledge
- `apps/gateway/src/app_server_api.rs`
  - `thread_resume`
  - `thread_loaded_list`

## Current State

- The frontend calls `resumeThread(selectedThread.id)` when `selectedThread.status` is `notLoaded` or `active`.
- The gateway resume route always calls app-server `thread/resume`.
- The selected-thread snapshot is loaded separately through `GET /v1/threads/{threadId}`.
- The selected-thread SSE stream starts after the snapshot returns a canonical `viewRevision`.
- Gateway `ThreadViewStore` already tracks live state and active turn id in memory, but the frontend does not ask the gateway whether resume is necessary.
- `thread/loaded/list` exists in the app-server schema and adapter for currently loaded in-memory app-server sessions.

## Decisions

- Selecting an `idle` thread should not attach/resume.
- Selecting a `notLoaded` thread should attach/resume because reading mode still expects live updates.
- Selecting an `active` thread should attach, but the gateway should no-op if it can prove the thread is already attached/live or already loaded in the current app-server process.
- Keep attach separate from canonical snapshot reads. Do not make `GET /v1/threads/{threadId}` behavior-changing.
- Start attach immediately and load the selected snapshot immediately; do not block first paint on attach when history can be read.

## Milestones

### 1. Add Gateway Attach API

Scope: `apps/gateway/src/routes/threads.rs`, `apps/gateway/src/api.rs`, route tests in `apps/gateway/src/routes/mod.rs`, and generated OpenAPI.

Work:

- Add `POST /v1/threads/{threadId}/attach`.
- Add `ThreadAttachResponse` and `ThreadAttachDisposition`.
- Gateway decision order:
  - return `alreadyAttached` without app-server resume when `ThreadViewStore` has a streaming/syncing live state or active turn id,
  - return `notNeeded` without app-server resume when durable runtime state is known idle/draining,
  - return `alreadyLoaded` without app-server resume when `thread/loaded/list` includes the thread id,
  - otherwise call app-server `thread/resume` and return `resumed`.
- Keep the existing `/resume` route for compatibility and automation paths.
- Preserve existing metadata-only resume behavior (`excludeTurns: true`, `persistExtendedHistory: true`).

Exit criteria:

- Backend tests prove already-attached active threads do not call app-server `thread/resume`.
- Backend tests prove idle runtime state does not call app-server `thread/resume`.
- Backend tests prove loaded app-server sessions do not call app-server `thread/resume`.
- Backend tests prove unknown selected threads still call app-server `thread/resume`.
- OpenAPI includes the new route and response schemas.

### 2. Move Frontend Selection To Attach

Scope: `apps/web/src/App.tsx`, `apps/web/src/timeline/useSelectedThreadTimeline.ts`, `apps/web/src/api/client.ts`, frontend tests, and generated types.

Work:

- Add `attachThread(threadId)` to the generated API client.
- Replace selection-time `resumeThread` usage with `attachThread`.
- Keep `resumeThread` for explicit compatibility callers.
- Remove the selected-timeline early return for `notLoaded` threads so snapshot loading can proceed while attach is in flight.
- Keep selected-thread SSE stream startup after snapshot revision is known.
- Preserve attach de-duping with `attachedThreadIdsRef` / `attachingThreadIdsRef`, using attach dispositions instead of assuming every call resumed.

Exit criteria:

- Frontend tests prove `notLoaded` selection calls `/attach`, loads the selected snapshot, and opens the timeline without a manual Resume affordance.
- Frontend tests prove active thread attach success is remembered if selection changes before the attach response resolves.
- Frontend tests prove already-attached selection does not call `/resume`.
- Existing selected timeline, composer state, and subagent deferral tests still pass.

### 3. Verify And Benchmark

Scope: focused automated tests and temporary local benchmark artifacts under `/private/tmp`.

Work:

- Regenerate frontend OpenAPI types from a temporary gateway.
- Run focused backend route/adapter tests.
- Run focused frontend shell/timeline tests and production build.
- Benchmark selected active/notLoaded attach flow against a temporary updated gateway if practical, recording request timing and whether `/attach` maps to resume/no-op in representative states.

Exit criteria:

- `cargo fmt --check`
- Focused gateway tests for attach/resume/thread detail.
- Focused frontend tests for shell and timeline selection.
- `cd apps/web && npm run build`
- `git diff --check`
- Benchmark artifact or documented reason if browser/local state cannot exercise all attach dispositions safely.

## Verification

- `cargo fmt --check`
- `cargo test -p kodex-gateway thread_attach`
- `cargo test -p kodex-gateway thread_routes_map_read_resume_fork_and_archive`
- `cargo test -p kodex-gateway adapter_maps_thread_and_turn_methods`
- `cd apps/web && npm test -- src/App.mvp.shell.test.tsx src/App.mvp.timeline.test.tsx src/App.mvp.composer-settings.test.tsx`
- `cd apps/web && npm test -- src/timeline/reducer.snapshot.test.ts src/App.subagents.test.tsx`
- `cd apps/web && npm test -- src/App.mvp.shell.test.tsx src/App.mvp.timeline.test.tsx src/App.mvp.composer-settings.test.tsx src/timeline/reducer.snapshot.test.ts src/App.subagents.test.tsx`
- `cd apps/web && npm run build`
- `git diff --check`

Benchmark artifact:

- `/private/tmp/kodex-thread-attach-benchmark-2026-05-20T07-15-00-896Z.json`

Independent review:

- Pass 1 found two low issues: effect ordering made snapshot start before attach, and frontend coverage only exercised the resumed attach response shape.
- Pass 2 reported: "No major issues remain."

## Risks And Open Questions

- `thread/loaded/list` is an app-server call. It should be cheaper than `thread/resume`, but it still adds work for unknown threads before falling through to resume.
- Runtime state is persisted and can be stale across restart. Use it only for known idle/draining no-op decisions, not as proof of active attachment.
- The frontend still gates attach calls by selected thread status to avoid idle attach traffic; gateway remains authoritative for whether a requested attach becomes resume or no-op.
- Browser validation is less important than API/request evidence here because the user-visible behavior should remain the same while request routing changes.
