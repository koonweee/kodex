# Backend Maintainability Audit

Scope: Rust gateway/backend code, backend tests, OpenAPI DTO boundaries, app-server integration boundaries, database/state ownership, and SSE/thread lifecycle ownership.

This audit was produced from an independent backend subagent pass. It is a cleanup and maintainability report, not an implementation plan.

## Executive Summary

The backend is generally moving in the right direction on state ownership: app-server JSON-RPC is schema-validated, the gateway owns multi-client queue/read/thread-view projections, and replay avoids reconstructing timeline rows from raw app-server events.

The biggest maintainability wins are not rewrites. They are splitting several oversized boundary modules, de-duplicating thread settings overlay logic, and replacing cross-module status strings with small typed contracts.

## Prioritized Opportunities

### P1: Split the app-server adapter by responsibility

References:
- `apps/gateway/src/app_server_api.rs:23`
- `apps/gateway/src/app_server_api.rs:1815`
- `apps/gateway/src/app_server_api.rs:2405`
- `apps/gateway/src/app_server_api.rs:4006`

`app_server_api.rs` mixes RPC methods, public DTOs, payload normalization, timeline row construction, compact display payload shaping, and tests in one 5.4k-line file.

Why this helps: app-server integration is a critical contract boundary. Keeping unrelated responsibilities in one file makes schema bumps, row-shaping fixes, and RPC changes harder to review safely.

Suggested shape:
- Extract pure timeline row/display helpers near `thread_view`.
- Move RPC client methods into an app-server client submodule while re-exporting current public types.
- Move existing row/normalization tests with the extracted helpers first, then split `CodexClient` tests after behavior is stable.

### P1: Split `Store` into migration plus domain modules

References:
- `apps/gateway/src/store.rs:505`
- `apps/gateway/src/store.rs:2600`
- `apps/gateway/src/store.rs:3875`
- `apps/gateway/src/store.rs:4212`

`store.rs` owns schema setup, events, projects/previews, approvals, notifications, reads, pins, queue, automations, row mapping, and tests in one 5.4k-line file.

Why this helps: storage is shared by most gateway workflows. Smaller modules would reduce merge conflicts and make it clearer which state is authoritative for each domain.

Suggested shape:
- Keep the `Store` type and public method names stable.
- Move `migrate` and legacy migrations into a storage migrations module.
- Move queue, automation, notification, and row-mapping methods into sibling modules.
- Move existing migration, legacy overlay, queue recovery, and automation tests with their modules before touching behavior.

### P1: Deduplicate thread settings permission overlay logic

References:
- `apps/gateway/src/routes/threads.rs:1145`
- `apps/gateway/src/routes/threads.rs:1839`
- `apps/gateway/src/events.rs:1111`
- `apps/gateway/src/events.rs:1185`

Route-driven settings updates and `thread/settings/updated` event ingestion both save/apply active permission profile patches and mutate raw payloads.

Why this helps: route/SSE drift here can create subtle multi-client bugs where one code path updates typed state differently from the raw payload projection.

Suggested shape:
- Extract a shared helper such as `thread_settings_projection`.
- Unit-test `Missing`, `Clear`, and `Set` patches against both typed `ThreadSummary` fields and `raw_payload`.
- Keep route and event ingestion tests as integration coverage for the shared helper.

### P1: Type the gateway thread runtime status vocabulary

References:
- `apps/gateway/src/store.rs:456`
- `apps/gateway/src/turn_lifecycle.rs:83`
- `apps/gateway/src/turn_lifecycle.rs:155`
- `apps/gateway/src/queue.rs:500`
- `apps/gateway/src/events.rs:1439`

Runtime states such as `starting`, `draining`, `syncing`, `active`, `streaming`, `idle`, and `unknown` are string literals across lifecycle, queue, event ingestion, and storage.

Why this helps: runtime state is gateway-owned shared truth. A small typed vocabulary would make invalid transitions and typo drift easier to catch.

Suggested shape:
- Introduce a `ThreadRuntimeStatus` enum with `as_str` and parse helpers while still storing text in SQLite.
- Update existing runtime/queue recovery tests to assert enum values.
- Add a parser test for unknown persisted values so older DB rows stay readable.

### P2: Add OpenAPI and app-server schema drift guardrails

References:
- `apps/gateway/src/api.rs:182`
- `apps/gateway/src/api.rs:318`
- `apps/gateway/src/schema.rs:8`
- `apps/gateway/src/schema.rs:10`
- `apps/gateway/src/routes/capabilities.rs:39`

The OpenAPI path/component list is manually maintained, and app-server schema include paths repeat the active schema version.

Why this helps: generated OpenAPI is the public gateway contract, and the app-server JSON Schema version must stay aligned with the configured Codex binary.

Suggested shape:
- Add a focused `/openapi.json` test that asserts critical backend-owned schemas and paths exist.
- Add a schema test that `apps/gateway/app-server-schema/<version>/VERSION` matches `APP_SERVER_SCHEMA_VERSION`.
- Consider a small helper or macro for schema `include_str!` paths to reduce version-bump mistakes.

### P2: Extract backend test support and split the route test monolith

References:
- `apps/gateway/src/routes/mod.rs:23`
- `apps/gateway/src/routes/mod.rs:70`
- `apps/gateway/src/routes/mod.rs:13558`
- `apps/gateway/src/routes/mod.rs:13663`
- `apps/gateway/src/routes/mod.rs:13901`

Production routes are modular, but route tests live in a roughly 14k-line module with shared fixtures and many fake app servers.

Why this helps: route tests are high value, but the current shape makes targeted changes slow and increases unrelated merge conflicts.

Suggested shape:
- Extract `test_state`, JSON/SSE helpers, and payload builders into `routes/test_support.rs` under `#[cfg(test)]`.
- Split tests by domain after the shared support is in place.
- Preserve coverage by moving tests mechanically first, then doing any behavioral refactors separately.

## Healthy Areas To Preserve

- App-server request validation is well placed: the adapter validates params before dispatch, and the JSON-RPC transport validates full messages. References: `apps/gateway/src/app_server_api.rs:768`, `apps/gateway/src/app_server.rs:280`.
- Startup compatibility probing and `/v1/capabilities` make schema/binary mismatch visible. References: `apps/gateway/src/app_server.rs:141`, `apps/gateway/src/routes/capabilities.rs:41`.
- The `thread_view` ownership comment and replay filtering encode the right multi-client contract: render canonical snapshots/patches/item deltas, not raw timeline replay. References: `apps/gateway/src/thread_view.rs:26`, `apps/gateway/src/events_replay.rs:71`.
- Patch scope validation before SSE emission is a useful guardrail. Reference: `apps/gateway/src/events.rs:975`.
- Queue drain uses gateway-owned persisted runtime claims, which is the right direction for multi-client correctness. References: `apps/gateway/src/queue.rs:364`, `apps/gateway/src/store.rs:3208`.

## Notes

No tests were run for this audit because it is documentation-only.
