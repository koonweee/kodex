# Gateway-Owned Attach State Plan

## Context

- Existing-thread sends can fail with app-server `thread not found` after gateway/app-server restart even when the thread appears in sidebar lists and `thread/read` succeeds.
- The current web client keeps `attachedThreadIdsRef` in `apps/web/src/App.tsx`, which treats current app-server loaded/attached state as browser-owned memory.
- The gateway `/v1/threads/{threadId}/attach` route in `apps/gateway/src/routes/threads.rs` can also no-op from persisted idle runtime state, which is not proof that the current app-server process has the thread loaded.
- The product decision is that attachment/loading is gateway-owned runtime state. The browser may dedupe in-flight requests, but it must not remember a thread as attached.

## Current State

- `apps/web/src/App.tsx` owns both `attachedThreadIdsRef` and `attachingThreadIdsRef`.
- The attach effect skips attach when either set contains the selected thread ID.
- New thread creation and active-thread events mark IDs as attached in the frontend.
- Archive cleanup deletes IDs from both frontend sets.
- Frontend tests in `apps/web/src/App.mvp.shell.test.tsx` assert that selecting an active thread, switching away, and selecting it again only calls `/attach` once.
- Gateway route tests in `apps/gateway/src/routes/mod.rs` assert `/attach` no-ops for known idle persisted runtime state.
- `apps/gateway/src/routes/turns.rs` now has a defensive one-shot resume/retry when `turn/start` reports missing thread; this should remain a fallback, not the primary attach mechanism.

## Milestones

### 1. Remove Frontend Attached-State Ownership

- Scope: `apps/web/src/App.tsx` and attach-related tests in `apps/web/src/App.mvp.shell.test.tsx`.
- Work:
  - Delete `attachedThreadIdsRef`.
  - Keep only `attachingThreadIdsRef` as an in-flight duplicate guard.
  - Stop marking created or active threads as attached in the frontend.
  - Stop treating attach success or no-op dispositions as browser-owned durable state.
  - Update tests so selecting an attach-eligible thread again can call `/attach` again, while concurrent duplicate attach calls are still prevented.
- Exit criteria:
  - Frontend tests prove attach is reissued after selection changes instead of remembered by the browser.
  - Existing selected-thread attach and live update behavior remains intact.

### 2. Make Gateway Attach Check Current App-Server State

- Scope: `apps/gateway/src/routes/threads.rs` and gateway route tests in `apps/gateway/src/routes/mod.rs`.
- Work:
  - Remove the `/attach` no-op based solely on persisted idle runtime state.
  - Keep no-op behavior for gateway live thread views and app-server `thread/loaded/list`.
  - Resume unknown/not-currently-loaded threads through `thread/resume`.
  - Keep the existing `turn/start` missing-thread resume/retry as a defensive fallback for races and non-UI callers.
- Exit criteria:
  - Gateway tests prove stale persisted idle runtime does not prevent `/attach` from checking app-server loaded state and resuming when needed.
  - Gateway tests prove loaded app-server sessions still no-op without resume.

### 3. Verification And Operational Smoke

- Scope: focused frontend/backend tests, production restart, and a targeted existing-thread smoke if practical.
- Work:
  - Run focused App attach tests.
  - Run focused gateway attach and turn-start retry tests.
  - Run format/build checks appropriate to touched frontend/backend files.
  - Restart local production gateway after implementation if tests pass.
  - Manually or via HTTP verify the previously failing thread can be read and no new `thread not found` errors are emitted during attach/sending smoke when practical.
- Exit criteria:
  - Focused tests pass.
  - Broader gateway/frontend checks pass or known environment-only failures are documented.
  - `plans/index.md` is updated when this plan completes.

## Verification

- `cargo fmt`
- `cargo test -p kodex-gateway routes::tests::thread_attach_resumes_despite_stale_idle_runtime`
- `cargo test -p kodex-gateway routes::tests::thread_attach_noops_when_app_server_session_is_loaded`
- `cargo test -p kodex-gateway routes::tests::thread_input_resumes_and_retries_when_turn_start_reports_missing_thread`
- `cd apps/web && npm test -- App.mvp.shell.test.tsx`
- `cd apps/web && npm run build`
- `cargo test -p kodex-gateway`, with the known sandbox-sensitive MCP test rerun outside the sandbox if needed.
- `$agent-browser` or equivalent local browser smoke for selecting an active/not-loaded thread after production restart when practical.

## Completion Notes

- Removed browser-owned attached-thread memory from `apps/web/src/App.tsx`; the frontend now keeps only in-flight attach dedupe.
- Changed gateway `/v1/threads/{threadId}/attach` to check current app-server loaded sessions before resuming, instead of trusting persisted idle runtime state.
- Kept the existing `turn/start` missing-thread resume/retry as a defensive fallback for races and non-UI callers.
- Verified focused gateway attach and send-retry tests, focused frontend shell/timeline/composer tests, `npm run build`, and `cargo test -p kodex-gateway`.
- The full gateway suite had one sandbox-sensitive MCP failure in the sandbox; the exact MCP test passed when rerun outside the sandbox.
- Restarted `kodex-prod`; the restart script reported the endpoint healthy at `2026-05-22 02:33:24` local time.
- Smoked previously failing thread `019e4bd5-e9f8-7342-807e-f70ae5c0a8ab`: read returned HTTP 200 with `status: notLoaded`, then `/attach` returned HTTP 200 with `disposition: resumed`.

## Risks And Open Questions

- Reissuing `/attach` on every re-selection adds one cheap gateway call for active/not-loaded threads. Gateway idempotence should make this acceptable.
- If app-server `thread/loaded/list` is itself stale, `thread/resume` and the turn-start fallback still protect correctness.
- The frontend still owns in-flight dedupe to avoid concurrent duplicate POSTs from a single render cycle; this is local UI bookkeeping, not attached-state ownership.
