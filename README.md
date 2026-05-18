<p align="center">
  <img src="apps/web/public/kodex-badge.png" alt="Kodex badge" width="160" />
</p>

# Kodex

Kodex is a local-first or VPN-only Codex gateway and web app built from scratch in a monorepo.

The MVP target is a Rust gateway that supervises an external `codex app-server` process over stdio, reads thread history through app-server snapshots, brokers approvals, and serves a React web client. The web client is intentionally replaceable later by another client.

## Current Status

The first Rust gateway implementation exists under `apps/gateway`. It includes the backend scaffold, SQLite project/approval/read-marker/queue/pin/automation/preview storage, diagnostic event replay, a stdio JSON-RPC app-server supervisor, HTTP/SSE API routes, approval brokering, OpenAPI generation, an app-server adapter layer, product-shaped frontend response DTOs, optional Caddy-backed project previews, focused first-party plugin install endpoints, app-server MCP inventory/resource/auth/config endpoints, a Kodex Control MCP stdio subcommand, and optional static frontend serving.

The first React web client exists under `apps/web`. It includes the Vite/Mantine scaffold, generated OpenAPI TypeScript types, a typed fetch client, project/thread navigation, pinned threads, stable draggable project ordering, attention-sorted threads, snapshot-first timeline rendering, gateway-backed queued composer follow-ups, composer controls, pending approval decisions, Preferences > Plugins for Kodex Control installation, Preferences > MCP for app-server MCP inventory/auth/resource inspection plus global MCP add/remove/enable/disable/replace, and account/model surfaces.

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
- `KODEX_KODEX_CONTROL_MARKETPLACE_PATH`
- `KODEX_PREVIEW_BIND`
- `KODEX_PREVIEW_PORT_RANGE`
- `KODEX_CADDY_ADMIN_BIND`
- `KODEX_PREVIEW_DATA_DIR`
- `KODEX_VAPID_PUBLIC_KEY`
- `KODEX_VAPID_PRIVATE_KEY`
- `KODEX_VAPID_SUBJECT`
- `KODEX_NOTIFICATIONS_RECHECK_DELAY_MS`

Local routes:

- `GET /healthz`
- `GET /readyz`
- `GET /openapi.json`
- `GET /docs`
- `GET /v1/events` for gateway-owned operational JSON replay and live SSE when `Accept: text/event-stream`. Normal replay is intentionally limited to approvals, gateway warnings, and queued composer row updates; selected-thread timeline history comes from snapshots, while live transcript updates are canonical `thread_view.patch` events, not persisted raw app-server timeline replay.
- `GET /v1/debug/events` for raw persisted gateway event replay. This is diagnostic/local-only and should not be used by canonical timeline loading.
- `POST /v1/uploads/images` for local image uploads used by browser-originated `localImage` turn inputs
- `GET /v1/threads/{threadId}/files/preview?path=...` for local/VPN-only image and Markdown previews of supported readable regular files.
- `POST /v1/threads/{threadId}/input` for browser composer submits. The gateway owns the routing decision: active threads create a durable shared queue row by default, stale active state is cleared when app-server readback shows no active turn, and idle or not-yet-materialized threads start a new turn. Explicit steering remains available through queued-row and turn steer routes.
- `GET /v1/threads/{threadId}/queued-inputs`, `POST /v1/threads/{threadId}/queued-inputs`, `POST /v1/threads/{threadId}/queued-inputs/{queueId}/retry`, `POST /v1/threads/{threadId}/queued-inputs/{queueId}/steer`, and `DELETE /v1/threads/{threadId}/queued-inputs/{queueId}` for the same-gateway persisted composer queue. Queue rows may include nullable `sourceType` and `sourceId` fields for gateway-originated work such as automations.
- `GET /v1/automations`, `POST /v1/automations`, `GET/PATCH/DELETE /v1/automations/{automationId}`, and `POST /v1/automations/{automationId}/pause|resume` for gateway-owned recurring prompts into a target thread. Automations have a 30-second minimum interval, coalesce missed due slots, use latest stored thread composer settings, and enqueue source-labeled input for the next idle turn rather than auto-steering active turns.
- `GET /v1/notifications/status`, `POST /v1/notifications/subscriptions`, and `DELETE /v1/notifications/subscriptions/{subscriptionId}` for optional Web Push subscription management. Push payloads are minimal unread-agent-message notices and do not include agent message text.
- `GET /v1/skills` for the gateway skill catalog and `GET /v1/skills/icon?path=...` for localhost/trusted-VPN skill icon previews used by enriched inline skill badges.
- `GET /v1/kodex-control-plugin` and `POST /v1/kodex-control-plugin/install` for the transitional first-party Kodex Control plugin install surface. This focused endpoint automatically adds the bundled marketplace and installs `kodex-control`; it should be replaced by generic `/v1/plugins` APIs when generic plugin management is built.
- `GET /v1/mcp/servers`, `GET /v1/mcp/configured-servers`, `POST /v1/mcp/servers`, `POST /v1/mcp/servers/{server}/replace`, `PATCH /v1/mcp/servers/{server}/enabled`, `DELETE /v1/mcp/servers/{server}`, `GET /v1/mcp/servers/{server}/resources/read`, `POST /v1/mcp/servers/{server}/oauth-login`, and `POST /v1/mcp/reload` for app-server MCP runtime inventory, global MCP config management, listed-resource reads, explicit OAuth login URL generation, and runtime MCP reload. These routes do not call MCP tools.
- `GET /v1/self-control/status`, `POST /v1/self-control/project-previews/apply`, `POST /v1/self-control/threads`, `POST /v1/self-control/threads/{threadId}/input`, and self-control automation routes under `/v1/self-control/automations` for guarded agent-facing Kodex Control mutations. MCP tools should use these routes instead of raw CRUD routes so provenance and safety policy stay gateway-owned.
- `GET /v1/projects/{projectId}/previews`, preview service/preview/route CRUD routes under `/v1/projects/{projectId}`, and `POST /v1/project-previews/reload` for gateway-owned project preview configuration and Caddy repair.
- Frontend-critical Codex routes such as `GET /v1/threads`, `GET /v1/threads/{threadId}`, `GET /v1/models`, `GET /v1/account`, `GET /v1/account/rate-limits`, and `POST /v1/account/login` expose typed gateway DTOs with `rawPayload` retained only as an escape hatch for volatile app-server fields. `GET /v1/threads/{threadId}` reads durable thread metadata/history from app-server and populates selected-thread timeline history through native `thread/turns/list` with `itemsView: "full"`. The gateway keeps only an in-memory TUI-like `ThreadView` for live selected-thread projection, canonical `thread_view.patch` events, and provisional user rows; app-server remains the durable transcript owner. Selected-thread SSE is a live overlay; reconnects or uncertain stream continuity trigger another snapshot read instead of replaying persisted timeline rows.

The gateway has no MVP auth and is intended only for localhost or a trusted VPN. Do not expose it directly to the public internet. ChatGPT/Codex login routes broker Codex/OpenAI auth through app-server APIs; they are not gateway access control. Queued composer rows and automations are shared only between browsers connected to the same gateway process and database; there is no multi-gateway coordination. Uploaded image files are local helper assets for app-server input and inherit the same local/trusted-network assumption. File previews intentionally serve any readable supported regular local file under those deployment assumptions, rather than enforcing a public-safe filesystem authorization model.

Preferences > MCP can write global Codex MCP config. Inline stdio environment values and HTTP header values are stored in local Codex config, not gateway SQLite, and Kodex masks them on readback; this is a usability guard, not a secure secret manager. Local-command MCP servers run their configured command when Codex loads the server. Removing a configured server removes its inline config values but does not delete app-server-owned OAuth credentials unless upstream adds and documents a supported MCP credential removal API.

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

## Kodex Control Plugin

This repo includes a first-party Codex plugin at `plugins/kodex-control`. The plugin packages the canonical `kodex-proxy-evaluation` skill and exposes a gateway-hosted MCP server for guarded self-control tools and read-only resources.

Install it from the web client:

1. Start the gateway with a ready Codex app-server.
2. Open the web client.
3. Open Preferences > Plugins.
4. Select Install on Kodex Control.

The install button uses the focused gateway endpoint to add `.agents/plugins/marketplace.json`, install `kodex-control`, and emit `skills.changed`. If the app-server is unavailable, install is blocked with a degraded status. Missing Caddy does not block plugin installation.

For non-web development, the bundled marketplace can be overridden with `KODEX_KODEX_CONTROL_MARKETPLACE_PATH`. The default is this checkout's `.agents/plugins/marketplace.json` when running from the repo.

The plugin MCP server is hosted by the gateway binary:

```bash
kodex-gateway mcp kodex-control
```

The MCP subcommand reads `KODEX_GATEWAY_URL`, defaulting to `http://127.0.0.1:8787`, and refuses non-loopback gateway URLs unless `KODEX_ALLOW_REMOTE_SELF_CONTROL=1` is set. It exposes tools for status, preview apply, thread input, and automation management, plus resources such as `kodex://status`, `kodex://projects`, and `kodex://automations`.

After installation, invoke the skill from another repo with a prompt such as:

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

The web app is built as an installable PWA. The service worker precaches built static assets only; API routes, SSE, OpenAPI, uploads, and file previews stay network-owned. App badge updates use gateway-owned unread completed-agent-turn state and silently no-op in browsers without the Badging API.

Browser notifications are optional. To enable Web Push, configure VAPID keys on the gateway:

```bash
KODEX_VAPID_PUBLIC_KEY=<base64url-public-key>
KODEX_VAPID_PRIVATE_KEY=<base64url-private-key>
KODEX_VAPID_SUBJECT=mailto:you@example.com
```

`KODEX_NOTIFICATIONS_RECHECK_DELAY_MS` defaults to `2000`; the gateway waits that long, rereads thread/read state, and skips the push if the thread has already been seen. Device push requires a secure browser context; localhost works for development, while phone/tablet testing over a tailnet or trusted VPN needs HTTPS termination in front of the local gateway. This does not change the MVP access model: keep the gateway on localhost or a trusted VPN, not the public internet.

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

The gateway validates outbound JSON-RPC client requests through the app-server adapter and validates the `initialized` notification against `apps/gateway/app-server-schema/0.130.0/json`. Thread start, resume, and fork requests always send `persistExtendedHistory: true`; selected-thread detail reads use `thread/turns/list` with `itemsView: "full"` for rich completed history; `/readyz` reports an incompatibility message if the configured app-server rejects required experimental fields.

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
