# App-Server Read-Through Thread Sync Plan

## Scope

Make Codex app-server the canonical source of truth for thread metadata, turns, and items. Kodex gateway should stop treating its SQLite event log as durable thread history and instead read through app-server snapshots, overlay only gateway-owned state, and use gateway-observed notifications as a low-latency live update source when available.

This is a hard-cut plan. No backwards compatibility is required for old gateway-only event replay semantics, stale checked-in app-server schemas, or Codex binaries that do not support the required experimental app-server fields.

## Status

Complete.

## Problem

Gateway currently stores app-server notifications in SQLite and the web timeline replays those events as if they are canonical thread history. That creates two sources of truth:

- App-server rollout/session state, which advances whenever any Codex client continues a thread.
- Gateway SQLite events, which only contain notifications observed by this gateway process.

When another client continues a gateway-created thread directly through app-server, gateway SQLite falls behind. The gateway may still read fresh thread metadata from app-server, but timeline history, read markers, and completion state can remain stale or incomplete.

## Target Architecture

- App-server owns thread metadata, status, names, previews, turns, and items.
- Gateway owns projects, read/unread markers, approval broker state, upload bookkeeping, UI preferences, and transient live-stream state.
- Gateway exposes one normalized thread/timeline API to the frontend.
- Gateway forwards app-server deltas for turns it can observe live.
- Gateway polls or refreshes app-server snapshots for externally active or externally advanced threads.
- Frontend reducers upsert turns/items by stable app-server ids and do not care whether an update came from a live delta or a polled snapshot.

## Required App-Server Contract

- Gateway initializes app-server with `capabilities.experimentalApi: true`.
- Checked-in app-server schemas are generated with experimental API enabled.
- Gateway sends `persistExtendedHistory: true` on `thread/start`, `thread/resume`, and `thread/fork`.
- Gateway fails readiness hard if the configured Codex app-server rejects `persistExtendedHistory` or the generated schema does not include the required experimental field.
- No lossy fallback mode is supported.

## Backend Milestone 1: Experimental Schema Hard Cut

Failing tests first:

- Schema validation fails if `ThreadStartParams`, `ThreadResumeParams`, or `ThreadForkParams` do not accept `persistExtendedHistory`.
- App-server compatibility startup/readiness test fails when the configured app-server rejects the required field.

Implementation:

- Update `apps/gateway/scripts/generate-app-server-schema.sh` to generate experimental schema output.
- Regenerate `apps/gateway/app-server-schema/<version>/json` from the pinned Codex binary.
- Update app-server adapter DTOs and outbound validation to include `persistExtendedHistory: true`.
- Add a startup compatibility check that validates the required field against the generated schema and app-server behavior.
- Make `/readyz` false with a clear incompatibility message when the requirement is not met.

Exit conditions:

- Generated schema includes the experimental fields gateway requires.
- Existing app-server request validation remains strict.
- `cargo test` passes.
- `README.md` and `AGENTS.md` document that schemas are always generated with experimental API enabled.

## Backend Milestone 2: Canonical Thread Snapshot API

Failing tests first:

- `GET /v1/threads/{id}` returns app-server `thread/read includeTurns:true` turn/item data even when gateway SQLite has no matching events.
- `GET /v1/threads` returns app-server metadata and overlays only gateway-owned read-state fields.
- SQLite event history gaps do not affect app-server-backed thread detail responses.

Implementation:

- Extend the app-server adapter to support `thread/read includeTurns:true` and `thread/turns/list` where paging is preferable.
- Replace timeline-detail construction that depends on gateway event replay with app-server thread snapshots.
- Keep SQLite `events` for transient SSE replay/debug if still useful, but remove it from canonical thread history decisions.
- Keep `thread_reads` or replace it with a gateway-owned read-state table keyed by app-server thread and completed turn ids.

Exit conditions:

- A thread continued by another app-server client is readable through gateway without needing stored gateway events.
- Read/unread state is computed from app-server completed turns plus gateway-owned seen markers.
- Gateway thread DTOs retain existing frontend-critical metadata unless intentionally replaced by generated OpenAPI changes.

## Backend Milestone 3: Unified Timeline Update Stream

Failing tests first:

- Gateway-owned active turns emit normalized `item_delta` updates for streaming agent text.
- Snapshot refreshes emit normalized `turn_upsert` and `item_upsert` updates.
- The same SSE channel can carry both live deltas and snapshot upserts without duplicate timeline rows.

Implementation:

- Define normalized gateway timeline update DTOs:
  - `turn_upsert`
  - `item_upsert`
  - `item_delta`
  - `thread_status`
  - `thread_metadata`
- Track gateway-observed active turns so gateway can label updates as `gatewayStream` or `appServerSnapshot` metadata.
- For gateway-started/resumed turns, forward app-server notifications immediately as normalized deltas/upserts.
- For snapshot refreshes, diff or conservatively upsert app-server turns/items by stable id.
- Do not expose separate frontend fetch protocols for streamed versus polled timelines.

Exit conditions:

- Streaming text remains low-latency for turns initiated through gateway.
- Externally active turns still progress through snapshot upserts even without token-level deltas.
- SSE reconnect behavior does not duplicate final items.

## Backend Milestone 4: External Activity Reconciliation

Failing tests first:

- When app-server `updatedAt` advances for a thread without gateway events, gateway detects the change and refreshes the selected thread snapshot.
- Active external turns continue to refresh until app-server reports idle or a completed/interrupted turn state.
- Multiple quick updates coalesce without unbounded app-server reads.

Implementation:

- Poll `thread/list` with `sortKey: updated_at` for recently updated threads while gateway is running.
- Refresh selected or subscribed threads more aggressively than background history.
- On thread selection, thread detail read, resume, and app startup, reconcile app-server snapshots before returning user-facing state.
- Store minimal sync metadata such as `thread_id`, `app_updated_at`, `last_synced_at`, and last sync error.
- Push reconciled updates over the same SSE stream used for live gateway deltas.

Exit conditions:

- Gateway converges when another client advances a thread while gateway is up.
- Gateway converges when it was down during external updates.
- App-server polling has bounded frequency and avoids broad full-history scans.

## Frontend Milestone 1: Snapshot-First Timeline State

Failing tests first:

- Opening a thread renders turns/items from app-server snapshot data without needing event replay.
- Reopening a thread whose history changed externally replaces or upserts items without duplicates.
- Existing optimistic user-message behavior still reconciles correctly against app-server item ids.

Implementation:

- Introduce timeline reducer actions for canonical snapshot load and item/turn upserts.
- Keep live delta handling as an update path layered on top of snapshot state.
- Normalize all timeline rows from app-server `ThreadItem` shapes and gateway update DTOs through the existing presentation helpers where possible.
- Remove assumptions that the initial timeline must be built from gateway `events`.

Exit conditions:

- Timeline presentation remains chat-first and keeps existing item-type coverage.
- Snapshot reloads preserve scroll/read behavior for selected threads.
- Frontend tests cover duplicate prevention and external-history replacement.

## Frontend Milestone 2: Unified Live State UX

Failing tests first:

- Frontend displays a running state for both `gatewayStream` and `appServerSnapshot` active updates.
- Streaming text renders incrementally when `item_delta` events arrive.
- Snapshot-polled external activity updates text/items in chunks without requiring different UI code.

Implementation:

- Add a small live-state field to thread detail and SSE updates:
  - `idle`
  - `streaming`
  - `syncing`
  - `notLoaded`
- Treat update `source` as metadata for labels/debug, not as a rendering fork.
- Keep gateway-managed polling invisible to normal frontend data fetching.
- Retain debug mode visibility into update source and raw payloads.

Exit conditions:

- Users can see that externally active threads are still progressing.
- Gateway-owned turns still feel streamed.
- Frontend has one timeline update reducer path, not separate streamed and polled timeline implementations.

## Frontend Milestone 3: API Type Regeneration

Failing tests first:

- TypeScript build fails until generated OpenAPI types include the new thread snapshot and timeline update DTOs.

Implementation:

- Regenerate backend OpenAPI after DTO changes.
- Regenerate `apps/web/src/api/generated/schema.ts`.
- Update typed API client wrappers and fixtures.

Exit conditions:

- No handwritten duplicate DTOs are introduced.
- `cd apps/web && npm test` passes.
- `cd apps/web && npm run build` passes.

## End-to-End Regression Plan

Scenarios:

- Gateway-started thread, gateway-owned turn:
  - Start a new thread through the web UI.
  - Send a prompt that streams agent text and runs at least one command.
  - Verify streaming text appears incrementally.
  - Verify final snapshot reload has no duplicate user, agent, command, or file-change rows.

- Gateway-started thread, external continuation while gateway is up:
  - Create a thread through gateway.
  - Continue it through a separate Codex client/app-server path.
  - Keep the web UI open on that thread.
  - Verify gateway detects app-server `updatedAt`, refreshes snapshots, and shows the new turn without manual reload.

- Gateway-started thread, external continuation while gateway is down:
  - Create a thread through gateway.
  - Stop gateway.
  - Continue the thread through another Codex client.
  - Restart gateway.
  - Verify thread list metadata, selected thread timeline, and read/unread state converge to app-server state.

- Legacy lossy prevention:
  - Configure or simulate an app-server that rejects `persistExtendedHistory`.
  - Verify gateway readiness fails hard and no new lossy thread can be started through gateway.

- Existing UI regressions:
  - Re-run timeline item coverage tests.
  - Re-run optimistic message tests.
  - Re-run composer send/stop and approval tests.
  - Re-run thread open performance smoke/benchmark on a long thread.

Commands:

- `cargo fmt`
- `cargo test`
- `cd apps/web && npm test`
- `cd apps/web && npm run build`
- `cd apps/web && npm run generate:api` after backend OpenAPI changes
- `cd apps/web && npm run test:e2e` for the final browser-flow milestone

## Documentation Updates

- Update `README.md` for the hard app-server compatibility requirement, experimental schema generation, and app-server-as-canonical-thread-source behavior.
- Update `AGENTS.md` to require experimental app-server schema generation going forward.
- Update this plan and [plans/index.md](index.md) as milestones move to Active or Complete.

## Design Decisions

- Use `thread/read includeTurns:true` for the selected thread detail path. Leave `thread/turns/list` out of the first implementation; consider it only later if large-thread payload size or open-time profiling proves that paged history is needed.
- Remove canonical dependence on gateway event replay and avoid adding a new replay cache in the first implementation. Prefer maintainability: SSE reconnects should recover from app-server snapshots plus any currently active gateway-owned stream state, not a parallel persisted event history.
- Start external active-thread polling with the selected thread only. Document this deliberately in the polling scheduler code so future global or project-scoped polling is added intentionally, with load and UX tradeoffs considered.
