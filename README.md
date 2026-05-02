# Kodex

Kodex is a local-first or VPN-only Codex gateway and web app built from scratch in a monorepo.

The MVP target is a Rust gateway that supervises an external `codex app-server` process over stdio, reads thread history through app-server snapshots, brokers approvals, and serves a React web client. The web client is intentionally replaceable later by another client.

## Current Status

The first Rust gateway implementation exists under `apps/gateway`. It includes the backend scaffold, SQLite project/approval/read-marker storage, diagnostic event replay, a stdio JSON-RPC app-server supervisor, HTTP/SSE API routes, approval brokering, OpenAPI generation, an app-server adapter layer, product-shaped frontend response DTOs, and optional static frontend serving.

The first React web client exists under `apps/web`. It includes the Vite/Mantine scaffold, generated OpenAPI TypeScript types, a typed fetch client, project/thread navigation, stable draggable project ordering, attention-sorted threads, snapshot-first timeline rendering, composer controls, pending approval decisions, and account/model surfaces.

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
- A `codex` binary on `PATH` for a ready app-server. The configured binary must support the checked-in experimental app-server schema, including `persistExtendedHistory`. The gateway still starts API-only if the app-server cannot be spawned, with `/readyz` reporting `ready: false`.
- Build and smoke-test helpers: a C toolchain/linker, `bash`, `curl`, `jq`, and optionally `sqlite3` for inspecting local test databases.

Backend Smoke Test Tooling:

```bash
# User-local Rust stable toolchain, including cargo and rustfmt.
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"
rustup component add rustfmt
```

System packages require root or `sudo` access. On WSL/Linux, install the build and smoke-test helpers with:

```bash
sudo apt-get update
sudo apt-get install -y build-essential pkg-config libsqlite3-dev curl jq sqlite3
```

Then verify the expected local tools are available:

```bash
cargo --version
rustc --version
rustfmt --version
codex --version
curl --version
jq --version
sqlite3 --version
```

Commands:

```bash
cargo fmt
cargo test
cd apps/web && npm test
cd apps/web && npm run build
cargo run -p kodex-gateway
apps/gateway/scripts/generate-app-server-schema.sh
```

API-only development:

```bash
cargo run -p kodex-gateway
```

Full-stack serving uses the gateway's static frontend hook. After a frontend build exists, point the gateway at the build directory:

```bash
KODEX_FRONTEND_DIST=apps/web/dist cargo run -p kodex-gateway
```

Production-style configuration can start from `apps/gateway/config/production.env.example`. With a gateway already running, run the smoke check with:

```bash
apps/gateway/scripts/smoke.sh http://127.0.0.1:8787
```

Default gateway config:

- Bind address: `127.0.0.1:8787`
- Database path: `~/.kodex/gateway.db`
- Image upload path: `${TMPDIR:-/tmp}/kodex/uploads/images`
- Codex command: `codex app-server --listen stdio://`
- Frontend static directory: disabled unless `KODEX_FRONTEND_DIST` points at a built frontend directory

Environment overrides:

- `KODEX_BIND`
- `KODEX_DATABASE_PATH`
- `KODEX_DATA_DIR`
- `KODEX_UPLOADS_DIR`
- `KODEX_CODEX_BINARY`
- `KODEX_CODEX_ARGS`
- `KODEX_FRONTEND_DIST`

Local routes:

- `GET /healthz`
- `GET /readyz`
- `GET /openapi.json`
- `GET /docs`
- `GET /v1/events` for gateway-owned operational JSON replay and live SSE when `Accept: text/event-stream`. Normal replay is intentionally limited to approvals and gateway warnings; selected-thread timeline history comes from snapshots, not persisted gateway events.
- `GET /v1/debug/events` for raw persisted gateway event replay. This is diagnostic/local-only and should not be used by canonical timeline loading.
- `POST /v1/uploads/images` for local image uploads used by browser-originated `localImage` turn inputs
- Frontend-critical Codex routes such as `GET /v1/threads`, `GET /v1/threads/{threadId}`, `GET /v1/models`, `GET /v1/account`, `GET /v1/account/rate-limits`, and `POST /v1/account/login` expose typed gateway DTOs with `rawPayload` retained only as an escape hatch for volatile app-server fields. `GET /v1/threads/{threadId}` reads `thread/read includeTurns:true` from app-server and is the canonical selected-thread timeline source. Selected-thread SSE is a live overlay; reconnects or uncertain stream continuity trigger another snapshot read instead of replaying persisted timeline rows.

The gateway has no MVP auth and is intended only for localhost or a trusted VPN. Do not expose it directly to the public internet. ChatGPT/Codex login routes broker Codex/OpenAI auth through app-server APIs; they are not gateway access control. Uploaded image files are local helper assets for app-server input and inherit the same local/trusted-network assumption.

Image uploads default to the system temp directory so Codex app-server can read `localImage` paths from its sandbox. If you override `KODEX_UPLOADS_DIR`, choose a path that app-server can read from the active sandbox profile, such as a project root or `/tmp`.

## Full-Stack Local Startup

For everyday local development, run the gateway and Vite dev server side by side. `tmux` is useful here because both servers keep running while you move between panes, inspect logs, or detach from the terminal.

```bash
tmux new -s kodex
```

Pane 1:

```bash
cargo run -p kodex-gateway
```

Split to a second pane with `Ctrl-b %`, then run:

```bash
cd apps/web
npm run dev
```

Open `http://127.0.0.1:5173`. Vite serves the React app and proxies `/v1` plus `/openapi.json` to the gateway at `http://127.0.0.1:8787`.

Useful tmux controls:

- Detach: `Ctrl-b d`
- Reattach: `tmux attach -t kodex`
- Stop both servers: reattach and press `Ctrl-c` in each pane

For production-style static serving from the gateway:

```bash
cd apps/web
npm run build
cd ../..
KODEX_FRONTEND_DIST=apps/web/dist cargo run -p kodex-gateway
```

Then open `http://127.0.0.1:8787`. Keep either setup local or trusted-VPN only; the MVP gateway has no access-control layer.

## Frontend Development

Prerequisites:

- Node.js and npm.
- A running gateway for live API calls and API type generation.

Commands:

```bash
cd apps/web
npm install
npm run dev
npm test
npm run test:e2e
npm run build
npm run generate:api
```

The Vite dev server runs on `127.0.0.1:5173` and proxies `/v1` plus `/openapi.json` to the default gateway at `127.0.0.1:8787`. To target another gateway, set `VITE_KODEX_API_BASE_URL`.

Playwright E2E tests run against mocked gateway responses and start their own Vite server on `127.0.0.1:5174`.

Frontend API types are generated from the gateway OpenAPI contract and committed at `apps/web/src/api/generated/schema.ts` so the client remains buildable from a fresh checkout. Regenerate them after backend DTO or route contract changes:

```bash
cargo run -p kodex-gateway
cd apps/web
npm run generate:api
```

Full-stack static serving uses the gateway's frontend dist hook:

```bash
cd apps/web
npm run build
cd ../..
KODEX_FRONTEND_DIST=apps/web/dist cargo run -p kodex-gateway
```

Gateway access remains localhost or trusted VPN only. The ChatGPT login UI only manages Codex/OpenAI account state through the app-server account APIs; it is not gateway access control.

## App-Server Schema

The checked-in app-server JSON Schema is generated from the exact Codex binary version used for gateway compatibility testing, always with experimental output enabled. Regenerate it after changing Codex versions:

```bash
apps/gateway/scripts/generate-app-server-schema.sh
```

The gateway validates outbound JSON-RPC client requests through the app-server adapter and validates the `initialized` notification against `apps/gateway/app-server-schema/0.128.0/json`. Thread start, resume, and fork requests always send `persistExtendedHistory: true`; `/readyz` reports an incompatibility message if the configured app-server rejects that required field.

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
