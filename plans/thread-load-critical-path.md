# Thread Load Critical Path Plan

## Status

Complete.

## Context

Thread selection currently waits on full selected-thread snapshot hydration, and active/not-loaded thread attachment can add duplicate app-server work. The immediate goal is to reduce critical-path app-server pressure without adding snapshot caches, new persistence, or partial-history semantics.

Relevant seams:

- `apps/web/src/timeline/useSelectedThreadTimeline.ts` owns selected-thread snapshot-first loading through `getThreadDetail`.
- `apps/web/src/App.tsx` separately attaches not-loaded/active threads with `resumeThread` and starts the selected subagent query.
- `apps/web/src/api/client.ts` exposes `resumeThread` and `listThreadSubagents`.
- `apps/gateway/src/routes/threads.rs` maps `POST /v1/threads/{threadId}/resume` and currently hydrates a full `ThreadViewResponse` after `thread/resume`.
- `apps/gateway/src/app_server_api.rs` maps `thread/resume`, `thread/fork`, `thread/read`, and `thread/turns/list`.
- `apps/gateway/app-server-schema/0.130.0/json/v2/ThreadResumeParams.json` supports `excludeTurns` for metadata-only resume responses.
- `apps/gateway/app-server-schema/0.130.0/json/v2/ThreadResumeResponse.json` documents that native resume turns are populated but lossy compared with `thread/turns/list itemsView:"full"`.

## Current State

- `GET /v1/threads/{threadId}` builds the canonical selected-thread timeline by calling `thread/read includeTurns:false`, then paginating `thread/turns/list` with `itemsView:"full"`, then applying gateway overlays.
- `POST /v1/threads/{threadId}/resume` calls app-server `thread/resume`, applies command response state, then calls the full detail path again before responding.
- The frontend already loads the selected thread snapshot independently after a thread becomes loaded/active, so returning a full timeline from `resume` is redundant for the visible selected-thread path.
- `list_subagents` is not a timeline source, but it can compete for app-server RPC because it calls `thread/loaded/list` and then reads loaded thread summaries.
- The repo requires public API changes to flow through Rust DTO/OpenAPI and generated frontend types.

## Milestones

### 1. Metadata-Only Resume Attach

Scope: `apps/gateway/src/app_server_api.rs`, `apps/gateway/src/routes/threads.rs`, generated OpenAPI/frontend types, and frontend resume client usage.

Work:

- Make app-server `thread/resume` requests include `excludeTurns: true` while preserving caller payload fields and `persistExtendedHistory`.
- Change gateway `POST /v1/threads/{threadId}/resume` to return `ThreadCommandResponse` after applying command response state, without calling `thread_view_response`.
- Update frontend `resumeThread` to return `ThreadCommandResponse` and keep `App.tsx` using the selected-thread snapshot loader as the sole canonical timeline hydration path.
- Regenerate OpenAPI and frontend TypeScript schema after the response DTO change.

Exit criteria:

- Backend route/adapter tests prove resume sends `excludeTurns: true` and no longer makes a follow-up full-history read.
- Frontend tests prove not-loaded and active thread selection still resumes/attaches and renders the selected snapshot from `GET /v1/threads/{threadId}`.

### 2. Defer Subagent Discovery Until Main Timeline Is Ready

Scope: `apps/web/src/App.tsx`, subagent tests, and query enablement/invalidation behavior.

Work:

- Enable `listThreadSubagents(selectedThread.id)` only after the selected timeline has reached the ready/streaming phase.
- Preserve existing behavior once enabled: robot hidden with zero rows, sidebar toggles, manual selection persists, and live events can invalidate the query.
- Avoid changing the gateway subagent endpoint or adding persistence.

Exit criteria:

- Frontend tests prove subagent discovery does not start while the main selected-thread snapshot is still loading.
- Existing subagent viewer behavior still passes after the main timeline is ready.

## Verification

- `cargo fmt`
- `cargo test -p kodex-gateway thread_routes_map_read_resume_fork_and_archive`
- `cargo test -p kodex-gateway adapter_maps_thread_and_turn_methods`
- `cd apps/web && npm test -- src/App.mvp.shell.test.tsx src/App.subagents.test.tsx`
- `cd apps/web && npm run build`

Browser validation is not required for this change because the intended UX is preserving existing rendered behavior while changing request timing and backend response shape. If manual UI validation is performed, verify selecting a not-loaded thread still shows its timeline and the subagent button appears only after the main timeline is ready.

## Risks And Open Questions

- `ThreadCommandResponse` must contain enough metadata for composer controls before the selected detail snapshot arrives. Existing command response parsing overlays top-level app-server settings onto `ThreadSummary`.
- If any caller expects `resumeThread` to apply a timeline snapshot directly, that caller must be moved to the existing selected-thread snapshot path instead.
- Deferring subagent discovery delays the robot button until after the main snapshot is usable. This is intentional to prioritize primary thread load.

## Completion Notes

- `thread/resume` now sends `excludeTurns: true` and gateway `POST /v1/threads/{threadId}/resume` returns `ThreadCommandResponse` without a follow-up full-history read.
- The selected-thread snapshot loader remains the only canonical timeline hydration path after resume.
- Subagent discovery now waits until the selected timeline is in a ready streaming/refreshing phase.
- Verified with focused backend tests, focused frontend tests, generated frontend OpenAPI types, and the web production build.
