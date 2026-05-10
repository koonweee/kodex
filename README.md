<p align="center">
  <img src="apps/web/public/kodex-badge.png" alt="Kodex badge" width="160" />
</p>

# Kodex

Kodex is a local-first or VPN-only Codex gateway and web app built from scratch in a monorepo.

The MVP target is a Rust gateway that supervises an external `codex app-server` process over stdio, reads thread history through app-server snapshots, brokers approvals, and serves a React web client. The web client is intentionally replaceable later by another client.

## Current Status

The first Rust gateway implementation exists under `apps/gateway`. It includes the backend scaffold, SQLite project/approval/read-marker/queue/pin/automation/preview storage, diagnostic event replay, a stdio JSON-RPC app-server supervisor, HTTP/SSE API routes, approval brokering, OpenAPI generation, an app-server adapter layer, product-shaped frontend response DTOs, optional Caddy-backed project previews, and optional static frontend serving.

The first React web client exists under `apps/web`. It includes the Vite/Mantine scaffold, generated OpenAPI TypeScript types, a typed fetch client, project/thread navigation, pinned threads, stable draggable project ordering, attention-sorted threads, snapshot-first timeline rendering, gateway-backed queued composer follow-ups, composer controls, pending approval decisions, and account/model surfaces.

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
- Project preview proxy: disabled/degraded unless `caddy` is installed; preview listeners use the concrete `KODEX_BIND` host by default
- Preview port range: `10000-19999`
- Caddy admin bind for the Kodex-owned preview process: `127.0.0.1:20191`

Environment overrides:

- `KODEX_BIND`
- `KODEX_DATABASE_PATH`
- `KODEX_DATA_DIR`
- `KODEX_UPLOADS_DIR`
- `KODEX_CODEX_BINARY`
- `KODEX_CODEX_ARGS`
- `KODEX_FRONTEND_DIST`
- `KODEX_CADDY_BINARY`
- `KODEX_PREVIEW_BIND`
- `KODEX_PREVIEW_PORT_RANGE`
- `KODEX_CADDY_ADMIN_BIND`
- `KODEX_PREVIEW_DATA_DIR`

Local routes:

- `GET /healthz`
- `GET /readyz`
- `GET /openapi.json`
- `GET /docs`
- `GET /v1/events` for gateway-owned operational JSON replay and live SSE when `Accept: text/event-stream`. Normal replay is intentionally limited to approvals, gateway warnings, and queued composer row updates; selected-thread timeline history comes from snapshots, not persisted gateway events.
- `GET /v1/debug/events` for raw persisted gateway event replay. This is diagnostic/local-only and should not be used by canonical timeline loading.
- `POST /v1/uploads/images` for local image uploads used by browser-originated `localImage` turn inputs
- `GET /v1/threads/{threadId}/files/preview?path=...` for local/VPN-only image and Markdown previews of supported readable regular files.
- `GET /v1/threads/{threadId}/queued-inputs`, `POST /v1/threads/{threadId}/queued-inputs`, `POST /v1/threads/{threadId}/queued-inputs/{queueId}/retry`, `POST /v1/threads/{threadId}/queued-inputs/{queueId}/steer`, and `DELETE /v1/threads/{threadId}/queued-inputs/{queueId}` for the same-gateway persisted composer queue. Queue rows may include nullable `sourceType` and `sourceId` fields for gateway-originated work such as automations.
- `GET /v1/automations`, `POST /v1/automations`, `GET/PATCH/DELETE /v1/automations/{automationId}`, and `POST /v1/automations/{automationId}/pause|resume` for gateway-owned recurring prompts into a target thread. Automations have a 30-second minimum interval, coalesce missed due slots, use latest stored thread composer settings, and enqueue source-labeled input for the next idle turn rather than auto-steering active turns.
- `GET /v1/skills` for the gateway skill catalog and `GET /v1/skills/icon?path=...` for localhost/trusted-VPN skill icon previews used by enriched inline skill badges.
- `GET /v1/projects/{projectId}/previews`, preview service/preview/route CRUD routes under `/v1/projects/{projectId}`, and `POST /v1/project-previews/reload` for gateway-owned project preview configuration and Caddy repair.
- Frontend-critical Codex routes such as `GET /v1/threads`, `GET /v1/threads/{threadId}`, `GET /v1/models`, `GET /v1/account`, `GET /v1/account/rate-limits`, and `POST /v1/account/login` expose typed gateway DTOs with `rawPayload` retained only as an escape hatch for volatile app-server fields. `GET /v1/threads/{threadId}` reads `thread/read includeTurns:true` from app-server and is the canonical selected-thread timeline source. Selected-thread SSE is a live overlay; reconnects or uncertain stream continuity trigger another snapshot read instead of replaying persisted timeline rows.

The gateway has no MVP auth and is intended only for localhost or a trusted VPN. Do not expose it directly to the public internet. ChatGPT/Codex login routes broker Codex/OpenAI auth through app-server APIs; they are not gateway access control. Queued composer rows and automations are shared only between browsers connected to the same gateway process and database; there is no multi-gateway coordination. Uploaded image files are local helper assets for app-server input and inherit the same local/trusted-network assumption. File previews intentionally serve any readable supported regular local file under those deployment assumptions, rather than enforcing a public-safe filesystem authorization model.

Image uploads default to the system temp directory so Codex app-server can read `localImage` paths from its sandbox. If you override `KODEX_UPLOADS_DIR`, choose a path that app-server can read from the active sandbox profile, such as a project root or `/tmp`.

## Project Previews

Project previews expose local dev services on stable ports through an isolated Caddy process owned by the gateway. They are intended for localhost or trusted-tailnet access only, matching the gateway's MVP security model.

Caddy is not bundled. Install it separately, then either keep `caddy` on `PATH` or set `KODEX_CADDY_BINARY`:

```bash
# macOS with Homebrew
brew install caddy

# Debian/Ubuntu
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update
sudo apt-get install caddy
```

Kodex does not mutate or reload an existing system/user Caddy service. It starts its own Caddy process with generated config, isolated data/config directories, and a Kodex-owned admin address. If Caddy is missing, the admin address is occupied, a preview port is occupied, or Caddy cannot start, the preview subsystem reports `disabled` or `degraded` while the main gateway continues running.

Preview binding follows these rules:

- `KODEX_PREVIEW_BIND` overrides the listener host for preview ports.
- Without `KODEX_PREVIEW_BIND`, previews use the concrete host from `KODEX_BIND`.
- If `KODEX_BIND` is a wildcard such as `0.0.0.0` or `[::]`, set `KODEX_PREVIEW_BIND` explicitly.
- Upstreams are loopback-only by design. A service is `http://127.0.0.1:<port>` plus a health path.
- Default public port allocation tries `10000 + root service port`, then the next free port in `KODEX_PREVIEW_PORT_RANGE`.

Example for a project with a Vite frontend on `3000` and NestJS backend on `4000`:

1. Bind the gateway to your trusted tailnet IP, for example `KODEX_BIND=100.64.0.10:8787`.
2. Open the project's settings pane from the project row.
3. Add services: `Frontend` port `3000`, `Backend` port `4000`.
4. Add an `App` preview rooted at `Frontend`, optionally using public port `13000`.
5. Add a route `/api/*` to `Backend`; enable strip prefix if the backend expects `/users` instead of `/api/users`.
6. Open `http://100.64.0.10:13000/` from another tailnet device.

## Kodex Proxy Evaluation Skill

This repo includes a reusable Codex skill at `.codex/skills/kodex-proxy-evaluation`. It lets another agent inspect an application repo, flag hardcoded browser-facing localhost/API origins, and propose Kodex project preview services, previews, routes, and strip-prefix settings.

Install it into a user-level Codex skills directory by copying or symlinking it:

```bash
mkdir -p ~/.codex/skills
cp -R .codex/skills/kodex-proxy-evaluation ~/.codex/skills/
```

For active development, a symlink keeps the installed skill pointed at this checkout:

```bash
mkdir -p ~/.codex/skills
ln -sfn "$PWD/.codex/skills/kodex-proxy-evaluation" ~/.codex/skills/kodex-proxy-evaluation
```

Then invoke it from another repo with a prompt such as:

```text
Use $kodex-proxy-evaluation to evaluate this repo for Kodex project preview proxy compatibility and propose proxy settings.
```

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

For production-style static serving from the gateway in a tmux pane:

```bash
tmux new -s kodex-prod
cd apps/web
npm run build
cd ../..
KODEX_FRONTEND_DIST=apps/web/dist cargo run -p kodex-gateway
```

Then open `http://127.0.0.1:8787`. The build step exits after writing `apps/web/dist`, and the gateway stays running in the pane to serve both the API and built frontend assets. Detach with `Ctrl-b d`, reattach with `tmux attach -t kodex-prod`, and stop the production-style server with `Ctrl-c` in that pane.

Keep either setup local or trusted-VPN only; the MVP gateway has no access-control layer.

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

The Vite dev server runs on `127.0.0.1:5173` and proxies `/v1` plus `/openapi.json` to the default gateway at `127.0.0.1:8787`. To proxy to another local gateway port during development, set `VITE_KODEX_PROXY_TARGET`. To bypass the Vite proxy and call another gateway origin directly, set `VITE_KODEX_API_BASE_URL`.

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
- Apply YAGNI: do not add multi-user auth, Redis, Postgres, plugin UI, or public SaaS concerns until required.
- Keep API contracts source-of-truth in backend code. Do not maintain separate handwritten request/response docs.
- Update `AGENTS.md`, `README.md`, and `plans/index.md` whenever behavior, commands, plan status, or project conventions change.

## Planned Documents

- [MVP backend implementation plan](plans/mvp-backend.md)
- [MVP frontend implementation plan](plans/mvp-frontend.md)
- [Future extensions overview](plans/future-extensions.md)
