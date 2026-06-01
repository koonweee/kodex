# Native Subagent Discovery Plan

## Status

Proposed.

## Context

Kodex currently discovers subagents by listing loaded threads, reading every loaded summary, and inferring parent/child relationships from raw app-server payloads. Codex app-server 0.133 release notes added extension lifecycle events that include subagent start/stop, and app-server thread summaries expose subagent names/roles when available. After the [Codex 0.135 app-server bump plan](codex-0-135-app-server-bump.md), this plan moves Kodex away from request-time scanning toward native lifecycle-driven subagent state where the app-server contract is sufficient.

## Current State

- `apps/gateway/src/routes/threads.rs` implements `GET /v1/threads/{threadId}/subagents` by calling `thread/loaded/list`, reading loaded thread summaries, and parsing `source.subAgent.thread_spawn.parent_thread_id`.
- `apps/web/src/threads/SubagentThreadViewer.tsx` renders an observer-only sidebar from the gateway endpoint.
- `apps/web/src/App.subagents.test.tsx` covers the current loaded-subagent UI behavior.
- `plans/thread-load-critical-path.md` already identified subagent discovery as deferred work because it competes for app-server RPC capacity.

## Goals

- Use app-server native subagent lifecycle signals as the primary source for currently loaded subagent relationships if the post-bump contract exposes enough data.
- Avoid request-time fan-out across all loaded threads for every parent thread.
- Keep the gateway as owner of the browser-visible subagent projection.
- Preserve the existing observer-only web UI unless native lifecycle data enables a clearly scoped enhancement.

## Non-Goals

- Do not add subagent attach, resume, control, or approval actions.
- Do not persist full subagent transcript history in Kodex.
- Do not expose extension-only internals to the browser as raw payloads.
- Do not block selected-thread load on subagent discovery.

## Milestones

### 1. Contract and Lifecycle Audit

- Verify whether post-bump subagent lifecycle events are part of the app-server client protocol or only extension hook internals.
- Confirm payload fields for parent thread id, child thread id, lifecycle status, nickname, role, model, service tier, and permission profile.
- Verify whether `thread/status/changed`, `thread/read`, or `thread/loaded/list` still needs to supplement lifecycle events after reconnect or gateway restart.
- If native events are insufficient, document the remaining gap and reduce the current scan path instead of pretending lifecycle state is authoritative.

### 2. Gateway Subagent Projection

- Add a gateway-owned subagent projection keyed by parent thread id.
- Populate it from native lifecycle events when available, and repair it from loaded-list/read only at startup, reconnect, or explicit uncertainty.
- Emit named gateway events for subagent start, stop, and metadata updates where frontend cache convergence needs them.
- Add backend tests for start, stop, duplicate events, missed-event repair, and parent-thread filtering.

### 3. Replace Request-Time Fan-Out

- Rework `GET /v1/threads/{threadId}/subagents` to read the gateway projection instead of scanning every loaded thread on each request.
- Keep bounded fallback repair when the projection is empty but loaded native state suggests uncertainty.
- Remove raw `source.subAgent.thread_spawn` parsing from the hot path once native lifecycle data covers it.
- Add profiling or timing assertions around selected-thread load so subagent discovery remains off the critical path.

### 4. Frontend Event Integration

- Keep `SubagentThreadViewer` as an observer-only surface, but update its data source invalidation to native gateway events.
- Replace polling or broad invalidation with parent-thread scoped cache updates.
- Update `apps/web/src/App.subagents.test.tsx` for start/stop event convergence and repair fallback.
- Use `$agent-browser` to verify the subagent sidebar does not delay selected-thread rendering.

## Verification

- `cargo fmt`
- `cargo test`
- Regenerate OpenAPI and frontend generated types if public events or DTOs change.
- `cd apps/web && npm test`
- `cd apps/web && npm run build`
- Use `$agent-browser` for a selected-thread load smoke with subagent sidebar open, plus a spawned-subagent lifecycle smoke when feasible.

## Risks And Open Questions

- The 0.133 subagent start/stop work may be extension lifecycle only, not a client app-server notification. If so, this plan should downgrade to optimizing the current loaded-list/read fallback.
- Parent relationship data may still only exist in raw thread summary payloads for older threads.
- Gateway restart recovery needs a bounded repair path because lifecycle-only in-memory state is not enough for same-gateway clients after reconnect.
