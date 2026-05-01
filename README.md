# Kodex

Kodex is a local-first or VPN-only Codex gateway and web app built from scratch in a monorepo.

The MVP target is a Rust gateway that supervises an external `codex app-server` process over stdio, persists and replays events, brokers approvals, and serves a React web client. The web client is intentionally replaceable later by another client.

## Current Status

The first Rust gateway implementation exists under `apps/gateway`. It includes the backend scaffold, SQLite event/project/approval storage, a stdio JSON-RPC app-server supervisor, HTTP/SSE API routes, approval brokering, OpenAPI generation, and optional static frontend serving.

See [plans/index.md](plans/index.md) for the plan directory and status table.

## MVP Assumptions

- Backend: Rust with `axum`, `tokio`, `sqlx`, and SQLite WAL.
- Frontend: React, Vite, and TypeScript.
- Codex integration: configurable external `codex` binary over stdio.
- Deployment: localhost or trusted VPN only.
- Gateway auth: none for MVP. Do not expose directly to the public internet.
- OpenAI/Codex auth: handled through Codex app-server account APIs.
- Streaming: SSE first, with WebSocket deferred until terminal or realtime requirements need it.
- Production packaging: gateway serves built React assets from the same binary or static directory.
- API contract: generated OpenAPI from Rust DTOs, served by the gateway, consumed by the frontend.

## Backend Development

Prerequisites:

- Rust stable toolchain with `cargo` and `rustfmt`.
- A `codex` binary on `PATH` for a ready app-server. The gateway still starts API-only if the app-server cannot be spawned, with `/readyz` reporting `ready: false`.

Commands:

```bash
cargo fmt
cargo test
cargo run -p kodex-gateway
apps/gateway/scripts/generate-app-server-schema.sh
```

Default gateway config:

- Bind address: `127.0.0.1:8787`
- Database path: `~/.kodex/gateway.db`
- Codex command: `codex app-server --listen stdio://`
- Frontend static directory: disabled unless `KODEX_FRONTEND_DIST` points at a built frontend directory

Environment overrides:

- `KODEX_BIND`
- `KODEX_DATABASE_PATH`
- `KODEX_DATA_DIR`
- `KODEX_CODEX_BINARY`
- `KODEX_CODEX_ARGS`
- `KODEX_FRONTEND_DIST`

Local routes:

- `GET /healthz`
- `GET /readyz`
- `GET /openapi.json`
- `GET /docs`
- `GET /v1/events` for JSON replay, or SSE when `Accept: text/event-stream`

The gateway has no MVP auth and is intended only for localhost or a trusted VPN. Do not expose it directly to the public internet. ChatGPT/Codex login routes broker Codex/OpenAI auth through app-server APIs; they are not gateway access control.

## App-Server Schema

The checked-in app-server JSON Schema is generated from the exact Codex binary version used for gateway compatibility testing. Regenerate it after changing Codex versions:

```bash
apps/gateway/scripts/generate-app-server-schema.sh
```

The gateway currently validates outbound JSON-RPC client requests and the `initialized` notification against `apps/gateway/app-server-schema/0.128.0/json`.

## Development Rules

- Write a failing test before implementation.
- Keep implementation DRY.
- Apply YAGNI: do not add multi-user auth, Redis, Postgres, plugin UI, automations, or public SaaS concerns until required.
- Keep API contracts source-of-truth in backend code. Do not maintain separate handwritten request/response docs.
- Update `AGENTS.md`, `README.md`, and `plans/index.md` whenever behavior, commands, plan status, or project conventions change.

## Planned Documents

- [MVP backend implementation plan](plans/mvp-backend.md)
- [MVP frontend implementation plan](plans/mvp-frontend.md)
- [Future extensions overview](plans/future-extensions.md)
