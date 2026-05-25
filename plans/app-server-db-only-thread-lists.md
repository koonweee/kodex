# App-Server DB-Only Thread Lists Plan

## Context

- Recent profiling showed app-server `thread/list` with scan-and-repair semantics is a major contributor to sluggish list and sidebar loading.
- The Codex app-server schema exposes `useStateDbOnly`, which returns thread list pages from the state DB without scanning JSONL rollouts to repair metadata.
- Direct local probing against the current Codex state showed the chat CWD-array first page returning the same first-page thread IDs in roughly 7 ms with `useStateDbOnly: true`, versus roughly 200-330 ms with the default repair path.
- The chosen product tradeoff is simple: use DB-only thread list calls for gateway list surfaces, keep `thread/read` and resume/open paths unchanged, and do not add automatic background repair in this pass.

## Starting State

- `apps/gateway/src/app_server_api.rs` has `thread_list`, `thread_list_recent_updated`, and `thread_list_cwds_updated`; all send `thread/list` without `useStateDbOnly`.
- `apps/gateway/src/routes/threads.rs` uses those adapter methods for project thread lists, chat thread lists, sidebar snapshots, selected-thread refresh helpers, and related list-derived metadata.
- Existing route tests in `apps/gateway/src/routes/mod.rs` assert `thread/list` call shapes for chat, project, sidebar, composer overlay, and lifecycle cases.
- The app-server schema at `apps/gateway/app-server-schema/0.130.0/json/ClientRequest.json` defines `useStateDbOnly` and `archived`.
- `AGENTS.md` requires API contracts to remain generated from Rust DTOs, frontend API types to stay generated, and behavior-changing work to add focused tests where practical.

## Milestones

### 1. Make App-Server Thread Lists DB-Only

- Scope: `apps/gateway/src/app_server_api.rs` and focused adapter tests in the same file.
- Work:
  - Add `useStateDbOnly: true` to gateway `thread/list` adapter calls.
  - Add `archived: false` to non-archived list requests so app-server filters archived rows before the gateway applies its existing defensive filtering.
  - Keep `thread/read`, `thread/resume`, `thread/start`, `thread/fork`, and turn routes unchanged.
- Exit criteria:
  - Adapter tests assert all gateway thread-list methods send `useStateDbOnly: true`.
  - Adapter tests assert list requests include `archived: false`.

### 2. Preserve Route Semantics

- Scope: `apps/gateway/src/routes/threads.rs` and route tests in `apps/gateway/src/routes/mod.rs`.
- Work:
  - Keep existing gateway-side archived filtering as a defensive compatibility layer.
  - Update or add route tests to prove chat/project/sidebar list paths receive the DB-only app-server parameters through the adapter.
  - Verify pinned list behavior remains read-summary based and does not switch to thread list semantics.
- Exit criteria:
  - Focused backend route tests pass for chat list, project list, sidebar snapshot, and pinned list behavior.
  - No public gateway DTO or OpenAPI shape changes are introduced.

### 3. Profile And Document Residual Risk

- Scope: profiling script and plan/index documentation.
- Work:
  - Run the existing hot-path profiler against local production if the environment is available.
  - Record the expected residual risk: DB-only lists can miss or show stale metadata for threads not correctly indexed in app-server SQLite, and manual repair remains out of scope for this pass.
  - Update this plan and `plans/index.md` when implementation completes.
- Exit criteria:
  - Focused tests and formatting pass.
  - Full relevant backend test slice passes, or any skipped broader check is documented with a concrete blocker.
  - Profiling results are captured when local production profiling is practical.

## Verification

- `cargo fmt`
- `cargo test -p kodex-gateway app_server_api::tests::adapter_maps_thread_list_read_archive_and_turn_start_interrupt_methods`
- Focused `cargo test -p kodex-gateway routes::tests::<thread-list/sidebar tests touched>`
- `cargo test -p kodex-gateway` if time and sandbox constraints allow, with any known sandbox-only failure documented.
- Optional local production profile: run `apps/gateway/scripts/profile-hot-paths.sh http://127.0.0.1:8787 <thread-id> /private/tmp/kodex-hot-path-profile-db-only-1.json`, repeating with distinct output paths for multiple samples.

## Risks And Open Questions

- Risk: DB-only list responses can miss disk-only or un-repaired rollout files. This is accepted for the simpler fast path in this plan.
- Risk: stale DB metadata can affect list ordering, preview/title, cwd filters, source/provider, archive visibility, git info, or agent labels. Opening a listed thread still uses app-server read paths and remains the correctness boundary for full history.
- Out of scope: automatic background repair, a manual repair endpoint, generated API shape changes, frontend UI changes, and app-server upstream changes.

## Completion Notes

- Implemented `useStateDbOnly: true` and `archived: false` for the gateway app-server `thread/list` adapter methods in `apps/gateway/src/app_server_api.rs`.
- Kept `thread/read`, pinned read-summary behavior, thread creation, resume, fork, and turn routes unchanged.
- Added adapter and route assertions covering chat, project, and sidebar list request shapes.
- Added a follow-up turn-start recovery path: if app-server reports `thread not found` for an existing-thread `turn/start`, the gateway resumes that thread once and retries the turn. This covers stale loaded-session state after gateway/app-server restarts without making normal list routes slow again.
- Rebuilt and restarted the local production tmux gateway on May 22, 2026.
- Local production HTTP profiling after restart, five sequential samples against `http://127.0.0.1:8787`:
  - `GET /v1/sidebar/threads`: median 27.448 ms, min 21.394 ms, max 34.464 ms, 45,486 bytes.
  - `GET /v1/threads/019e4e0e-3d61-7d01-936e-10789d1ccf2a`: median 10.007 ms, min 9.583 ms, max 10.308 ms, 13,703 bytes.
- Previous local production sidebar baseline from the same investigation was roughly 450 ms median for `GET /v1/sidebar/threads`.
