# MVP Backend Implementation Plan

## Scope

Build the first Kodex backend as a Rust gateway for a local-first or VPN-only single-user deployment. The gateway supervises an external `codex app-server` process over stdio, translates app-server JSON-RPC into product-shaped HTTP and SSE APIs, persists replayable events, brokers approvals, and serves the built React frontend.

## Principles

- Red first: each feature starts with a failing unit, integration, contract, or route test.
- DRY: use one app-server JSON-RPC client, one event ingestion path, one approval broker, and one error mapping layer.
- YAGNI: do not add multi-user auth, Redis, Postgres, distributed workers, automations, plugin UI, or public SaaS controls in MVP.
- Documentation is part of done: update `README.md`, `AGENTS.md`, and [plans/index.md](index.md) when behavior, commands, workflow, or plan status changes.

## Stack

- Rust workspace crate under `apps/gateway`.
- `axum` for HTTP routes and SSE.
- `tokio` for process supervision, async IO, channels, timers, and graceful shutdown.
- `serde` and `serde_json` for JSON-RPC and API DTOs.
- `sqlx` with SQLite WAL for projects, events, approvals, and snapshots.
- `tower-http` for tracing, compression, CORS, and static asset serving.
- `tracing` and `tracing-subscriber` for structured logs.
- `thiserror` for typed errors and `anyhow` only at process/application boundaries.

## Milestone 0: Backend Scaffold

Status: Proposed

Failing tests first:

- Gateway config loads defaults.
- Default bind address is `127.0.0.1:8787`.
- SQLite path default resolves under `~/.kodex` or configured data dir.
- Test command fails before the crate exists.

Implementation:

- Create `apps/gateway` crate.
- Add config model:
  - `server.bind = "127.0.0.1:8787"`
  - `server.trusted_network_only = true`
  - `codex.binary = "codex"`
  - `codex.args = ["app-server", "--listen", "stdio://"]`
  - `database.path = "~/.kodex/gateway.db"`
- Add application state wiring with dependency injection for tests.
- Add minimal router with `GET /healthz`.

Documentation:

- Update root `README.md` with backend run and test commands once they exist.
- Update `AGENTS.md` with backend-specific command conventions.
- Update [plans/index.md](index.md) status when work starts or completes.

## Milestone 1: App-Server Supervisor and JSON-RPC Client

Status: Proposed

Failing tests first:

- A fake app-server process is spawned.
- The client sends `initialize`.
- The client sends `initialized` after initialize succeeds.
- Responses are routed to the matching request ID.
- Notifications are routed to the event ingress channel.
- Server requests are routed to the approval broker channel.
- Child process exit changes readiness state.

Implementation:

- Add `AppServerSupervisor`.
- Spawn configured `codex` binary with stdio pipes.
- Implement newline-delimited JSON read/write loop.
- Implement request ID allocator.
- Implement pending request map.
- Implement typed request envelope with raw JSON payloads first.
- Initialize with:
  - `clientInfo.name = "kodex_gateway"`
  - `clientInfo.title = "Kodex Gateway"`
  - `capabilities.experimentalApi = true`
- Add graceful shutdown and child process cleanup.

YAGNI boundaries:

- Do not embed `codex-rs`.
- Do not support multiple app-server processes until project isolation requires it.
- Do not expose raw app-server websocket.

## Milestone 2: SQLite Store and Migrations

Status: Proposed

Failing tests first:

- Migrations create expected tables.
- WAL mode is enabled.
- Appending events assigns monotonic `seq`.
- Replay from a cursor returns ordered events.
- Approval insert and resolve transitions are valid.

Initial tables:

- `events`
  - `seq integer primary key autoincrement`
  - `id text not null unique`
  - `received_at text not null`
  - `project_id text`
  - `thread_id text`
  - `turn_id text`
  - `item_id text`
  - `kind text not null`
  - `codex_method text`
  - `payload_json text not null`
- `projects`
  - `id text primary key`
  - `name text not null`
  - `cwd text not null unique`
  - `created_at text not null`
  - `updated_at text not null`
- `approvals`
  - `id text primary key`
  - `request_id text not null`
  - `thread_id text`
  - `turn_id text`
  - `item_id text`
  - `method text not null`
  - `status text not null`
  - `payload_json text not null`
  - `response_json text`
  - `created_at text not null`
  - `resolved_at text`

Implementation:

- Add migration runner.
- Add repository traits or small store structs.
- Persist app-server notifications before broadcasting.
- Persist server requests as approval records before broadcasting.

DRY boundaries:

- One store API for event append and replay.
- One status transition function for approvals.

## Milestone 3: HTTP and SSE API Shell

Status: Proposed

Failing tests first:

- `GET /healthz` returns 200.
- `GET /readyz` reflects app-server readiness.
- `GET /v1/capabilities` returns gateway and app-server status.
- `GET /v1/events?cursor=` replays persisted events.
- SSE sends replay before live events.

Implementation:

- Add axum router.
- Add structured API error type.
- Add request tracing.
- Add local-dev CORS only.
- Add SSE endpoint using event replay plus broadcast channel.
- Add static asset serving hook for future built frontend.

API:

- `GET /healthz`
- `GET /readyz`
- `GET /v1/capabilities`
- `GET /v1/events?cursor=&projectId=&threadId=`

YAGNI boundaries:

- No WebSocket until terminal or realtime requires bidirectional browser transport.
- No gateway auth in MVP. Document localhost/VPN-only assumption clearly.

## Milestone 4: Projects and Threads

Status: Proposed

Failing tests first:

- Project create rejects relative cwd.
- Project create rejects missing cwd.
- Thread start maps to `thread/start`.
- Thread list maps to `thread/list`.
- Thread resume maps to `thread/resume`.
- Thread fork maps to `thread/fork`.
- Thread archive maps to `thread/archive`.

Implementation:

- Add project CRUD subset.
- Store project cwd and validate it exists.
- Build app-server thread request mapper.
- Keep app-server response payloads mostly raw, with only gateway fields needed for routing.

API:

- `GET /v1/projects`
- `POST /v1/projects`
- `GET /v1/projects/:projectId`
- `GET /v1/threads?projectId=&cursor=&limit=`
- `POST /v1/threads`
- `GET /v1/threads/:threadId`
- `POST /v1/threads/:threadId/resume`
- `POST /v1/threads/:threadId/fork`
- `POST /v1/threads/:threadId/archive`

Documentation:

- Document project cwd trust model in `README.md`.

## Milestone 5: Turns and Event Timeline

Status: Proposed

Failing tests first:

- Starting a turn maps to `turn/start`.
- Steering a turn maps to `turn/steer`.
- Interrupting a turn maps to `turn/interrupt`.
- `item/agentMessage/delta` notification is persisted and streamed.
- `turn/completed` notification is persisted and streamed.
- App-server overload error maps to a retryable gateway error.

Implementation:

- Add turn request mappers.
- Add notification metadata extraction for `threadId`, `turnId`, and `itemId`.
- Add retryable error shape for app-server `-32001`.
- Add event kind classification:
  - `codex.notification`
  - `codex.server_request`
  - `approval.created`
  - `approval.resolved`
  - `gateway.warning`

API:

- `POST /v1/threads/:threadId/turns`
- `POST /v1/threads/:threadId/turns/:turnId/steer`
- `POST /v1/threads/:threadId/turns/:turnId/interrupt`

DRY boundaries:

- One notification classifier.
- One JSON-RPC request execution wrapper.

## Milestone 6: Approval Broker

Status: Proposed

Failing tests first:

- Command approval server request creates a pending approval.
- File-change approval server request creates a pending approval.
- Permission approval server request creates a pending approval.
- MCP elicitation request creates a pending approval.
- Resolving an approval sends the JSON-RPC response to app-server.
- Resolved approval emits an event.
- Resolving an unknown or already-resolved approval fails safely.

Supported server requests:

- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`
- `item/permissions/requestApproval`
- `mcpServer/elicitation/request`
- `item/tool/requestUserInput`

Implementation:

- Map app-server server request IDs to durable `approvalId`.
- Store pending approvals.
- Validate decision payloads by approval method.
- Send JSON-RPC response through the app-server client.
- Emit `approval.resolved`.

API:

- `GET /v1/approvals?status=pending&threadId=`
- `GET /v1/approvals/:approvalId`
- `POST /v1/approvals/:approvalId/decision`

YAGNI boundaries:

- No policy engine.
- No approval delegation.
- No persistent "always allow" UI beyond app-server-provided decision variants.

## Milestone 7: Account and Models

Status: Proposed

Failing tests first:

- Account read maps to `account/read`.
- ChatGPT login maps to `account/login/start`.
- Login cancel maps to `account/login/cancel`.
- Logout maps to `account/logout`.
- Rate limits map to `account/rateLimits/read`.
- Model list maps to `model/list`.

Implementation:

- Add account route mappers.
- Add model route mapper.
- Surface `account/login/completed`, `account/updated`, and `account/rateLimits/updated` through existing event stream.

API:

- `GET /v1/account?refreshToken=false`
- `POST /v1/account/login`
- `POST /v1/account/login/:loginId/cancel`
- `POST /v1/account/logout`
- `GET /v1/account/rate-limits`
- `GET /v1/models?includeHidden=false`

Documentation:

- Clarify that ChatGPT auth is Codex/OpenAI auth, not public gateway auth.

## Milestone 8: Frontend Static Serving and Release Readiness

Status: Proposed

Failing tests first:

- Gateway serves frontend `index.html` when built assets exist.
- API routes continue to win over frontend fallback.
- Missing frontend build does not break API-only development.

Implementation:

- Add static file service.
- Add SPA fallback.
- Add production config example.
- Add smoke test script.

Documentation:

- Update `README.md` with full-stack run and build instructions.
- Update [plans/index.md](index.md) milestone status.

