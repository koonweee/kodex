# Native Thread Sync Events Plan

## Status

Proposed.

## Context

Codex app-server now emits native loaded-thread state notifications such as `thread/status/changed` and `thread/settings/updated`. Kodex already has a gateway-owned canonical `ThreadView`, named SSE events, selected-thread reconciliation, and frontend cache routing. After the [Codex 0.135 app-server bump plan](codex-0-135-app-server-bump.md), this plan consumes the native app-server notifications to reduce polling and local inference while preserving the gateway as the browser contract owner.

## Current State

- `apps/gateway/src/events.rs` normalizes app-server turn/item/timeline methods into gateway events and `thread_view.patch`.
- Selected-thread reconciliation still uses refetches and recent-list polling in places where native status/settings notifications can provide a direct signal.
- `thread_view.refresh_required` remains a refetch signal, not a timeline row source.
- The frontend must consume gateway canonical snapshots, patches, and named events rather than raw app-server lifecycle events.

## Goals

- Map native `thread/status/changed` into gateway-owned thread status updates.
- Map native `thread/settings/updated` into gateway-owned selected-thread setting updates.
- Reduce or remove reconciliation polling that exists only because app-server previously lacked explicit status/settings events.
- Preserve two-tab convergence through gateway SSE and snapshot refetches.

## Non-Goals

- Do not make React render app-server raw lifecycle events directly.
- Do not change canonical timeline row ownership.
- Do not remove snapshot recovery for missed events.
- Do not add WebSocket transport.

## Milestones

### 1. Contract and Event Audit

- Verify exact notification names and payloads in the bumped generated schema and app-server README.
- Classify each native event as metadata, selected-thread settings, status, or timeline-affecting.
- Decide the gateway public event names and whether existing events can be extended without frontend churn.
- Add failing tests for native status/settings notifications that currently fall through as unknown or require polling to converge.

### 2. Gateway Event Normalization

- Extend app-server ingest in `apps/gateway/src/events.rs` to parse native thread status and settings notifications.
- Update gateway thread view state and sidebar/read models through canonical reducer paths.
- Emit durable or replayable gateway named events only where reconnect correctness requires them.
- Keep unknown notification logging useful without treating every upstream method as a browser contract.

### 3. Replace Redundant Reconciliation

- Audit selected-thread and sidebar reconciliation paths for polling or broad refetches whose only purpose is status/settings freshness.
- Replace those paths with event-driven cache updates plus bounded refetch on missed cursors or `refresh_required`.
- Preserve startup recovery by reading gateway snapshots first.
- Add backend tests for event ordering around turn start, settings update, thread close, and resume.

### 4. Frontend Cache Routing

- Update `apps/web` event-to-query-cache routing so thread summaries, selected thread detail, and composer settings converge from gateway events.
- Add focused tests for stale selected-thread settings, status changes, and missed-event refetch behavior.
- Add a two-tab scenario where one tab changes settings or starts/stops a turn and the other converges without reload.

## Verification

- `cargo fmt`
- `cargo test`
- Regenerate OpenAPI and frontend generated types if public events or DTOs change.
- `cd apps/web && npm test`
- `cd apps/web && npm run build`
- Use `$agent-browser` for a two-tab selected-thread smoke that exercises a settings change and a turn status change.

## Risks And Open Questions

- Some status transitions may still be visible only through turn/item events or loaded-list snapshots; do not remove recovery paths until coverage proves parity.
- Event ordering between `turn/start` responses and `thread/settings/updated` notifications may require idempotent reducer updates.
- The gateway event store should remain operational and compact; do not reintroduce raw notification replay as browser transcript history.
