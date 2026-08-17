# Development

This guide covers local setup, common workflows, tests, and generated contracts. Kodex is a Rust workspace with a React/TypeScript web app.

## Prerequisites

- Rust stable with `cargo` and `rustfmt`.
- A compatible `codex` binary on `PATH`. The gateway can start API-only without it, but `/readyz` reports `ready: false`.
- Node.js and npm.
- A C toolchain/linker, `bash`, `curl`, and `jq` for backend builds and smoke checks.
- Optional: `sqlite3` for inspecting local databases and `tmux` for running both development servers.

On Debian or Ubuntu, the system build dependencies are:

```bash
sudo apt-get update
sudo apt-get install -y build-essential pkg-config libsqlite3-dev curl jq sqlite3
```

## Local development

Start the gateway from the repository root:

```bash
cargo run -p kodex-gateway
```

Start the web client in another terminal:

```bash
cd apps/web
npm install
npm run dev
```

Open `http://127.0.0.1:5173`. Vite proxies `/v1` and `/openapi.json` to `http://127.0.0.1:8787` by default.

To proxy to another local gateway, set `VITE_KODEX_PROXY_TARGET`. To call another gateway origin directly, set `VITE_KODEX_API_BASE_URL`.

App surfaces require a sandbox document on a different browser origin. Loopback development swaps `localhost` and `127.0.0.1` automatically. Remote browsers and HTTPS or non-loopback deployments must set `VITE_KODEX_APP_SURFACE_SANDBOX_URL` to the sandbox HTML on a distinct origin.

## Validation commands

Backend:

```bash
cargo fmt
cargo test
./tools/trim-backend.sh
```

Frontend:

```bash
cd apps/web
npm test
npm run test:e2e
npm run build
npm run trim
```

Playwright uses mocked gateway responses and starts its own Vite server on `127.0.0.1:5174`.

## Production-style local serving

Build the web app and have the gateway serve the static assets:

```bash
cd apps/web
npm run build
cd ../..
KODEX_FRONTEND_DIST=apps/web/dist cargo run -p kodex-gateway
```

Open `http://127.0.0.1:8787`. Keep this setup on localhost or a trusted private network.

Configuration can start from `apps/gateway/config/production.env.example`. With the gateway running, smoke-test it with:

```bash
apps/gateway/scripts/smoke.sh http://127.0.0.1:8787
```

## Generated contracts

### Gateway OpenAPI

Rust DTOs and routes generate the gateway's OpenAPI contract. Inspect it at `/docs` or `/openapi.json` on a running gateway.

Regenerate the committed frontend types after backend contract changes:

```bash
cargo run -p kodex-gateway
cd apps/web
npm run generate:api
```

The output lives at `apps/web/src/api/generated/schema.ts`. Do not hand-write duplicate frontend DTOs or a separate route contract.

### Codex app-server schema

The checked-in schema is generated from the exact Codex binary used for compatibility testing, with experimental API output enabled. After changing Codex versions, run:

```bash
apps/gateway/scripts/generate-app-server-schema.sh
```

Keep the configured Codex binary version aligned with `apps/gateway/app-server-schema/<version>/VERSION`.

## Repository conventions

- Keep the browser a thin projection of gateway and app-server state.
- Put API calls in `api`, SSE behavior in `events`, and feature behavior in its closest frontend domain module.
- Treat generated OpenAPI and generated app-server schemas as contracts.
- Match tests to user-visible and shared-state risk; documentation-only changes do not require the code test suites.
- Keep local/private-network assumptions explicit in features and documentation.

Contributor workflow and detailed implementation constraints live in [`AGENTS.md`](../AGENTS.md). Active and completed implementation plans are indexed in [`plans/index.md`](../plans/index.md).
