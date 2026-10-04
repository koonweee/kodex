# Architecture

Kodex is a browser-based workspace built around an external Codex app-server. Its design keeps the browser thin, the gateway authoritative for shared product state, and app-server authoritative for native Codex state.

## Components

| Component | Responsibility |
| --- | --- |
| React PWA | Renders projects, threads, timelines, approvals, terminals, settings, and app surfaces. Holds only browser-local interaction state where possible. |
| Rust gateway | Supervises app-server, exposes HTTP/SSE/WebSocket APIs, brokers approvals, projects app-server state, and owns local capabilities. |
| Codex app-server | Runs Codex sessions and remains the durable source of truth for thread transcripts and Codex account state. |
| SQLite | Stores gateway-owned queues, generated-app grants, read markers, pins, automations, notifications and diagnostic events. Native projects and approvals are not persisted here. |
| Host integrations | Provide PTY terminal sessions, supported local-file previews, uploads and static frontend serving. |

## State ownership

Shared state must survive reloads, reconnects, and multiple browser tabs. Kodex therefore keeps shared lifecycle decisions in the gateway or upstream app-server instead of deriving them from one browser's event stream.

- App-server owns native project roots, metadata, order and thread membership, durable transcript history, Codex session lifecycle and native approval requests. Project roots organize chats; they neither grant filesystem permissions nor change existing chat working directories.
- Gateway mirrors native approvals in connection-scoped memory and projects canonical thread state.
- Gateway still owns queued input, read state, pins, automations, notifications and generated-app grants. Queue, settings and sidebar ownership are changing under the active native redesign plan.
- The browser may own drafts, focus, open dialogs, scroll position, and other per-tab presentation state.

Selected-thread history is loaded from bounded app-server snapshots. Live SSE updates form a temporary projection over that snapshot; reconnects or uncertain continuity cause a fresh snapshot read instead of replaying a second persisted transcript.

## Transport and API

- JSON-RPC over stdio connects the gateway to `codex app-server`.
- HTTP exposes snapshots and commands to the web client.
- Server-Sent Events carry gateway events and selected-thread live projections.
- WebSocket carries interactive PTY terminal input, resizing, and output.

Native project notifications invalidate authoritative sidebar snapshots rather than patching a second project registry. Project deletion also refreshes open thread snapshots, because the native membership notification excludes archived threads. A lagged SSE stream emits its existing refresh signals and closes at its previous cursor. Reconnection replays operational invalidations, and the browser refills current native state.

The generated OpenAPI document is the API contract. With the gateway running, use:

- `GET /docs` for interactive local API documentation.
- `GET /openapi.json` for the generated schema.

Frontend types are generated from that schema and committed at `apps/web/src/api/generated/schema.ts`. Kodex intentionally does not maintain a parallel handwritten route reference.

## Codex compatibility

The checked-in app-server schema under `apps/gateway/app-server-schema/<version>/json` defines the supported protocol. The gateway validates outbound client requests and the app-server `initialized` notification against it.

Thread start, resume, and fork use the exact 0.160.0 history parameters. Selected-thread detail uses bounded, full-item history pages so the browser can render rich completed history without owning a duplicate transcript. `/readyz` reports incompatibilities, and `/v1/capabilities` exposes the checked-in schema version plus the configured Codex CLI version when detectable.

Regenerate the schema whenever the supported Codex binary version changes; see [Development](development.md#generated-contracts).

## Security boundary

Kodex is designed for localhost or a trusted private network. It has no gateway authentication layer. Codex account login manages upstream Codex/OpenAI account state and does not restrict access to Kodex itself.

Anyone who can reach the gateway can potentially use its terminals, read supported local files, start configured MCP commands, and operate other host-level features with the gateway process's permissions. Review the full deployment considerations before binding beyond loopback: [Deployment security](deployment.md#security-model).

## Current scope

The current implementation includes the Rust gateway, React PWA, gateway-host PTY terminals, app surfaces, MCP management, the Kodex Control plugin, automations, and optional Web Push. The browser client is designed to be replaceable without changing the app-server or gateway ownership model.
