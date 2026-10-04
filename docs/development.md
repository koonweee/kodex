# Development

This guide covers local setup, common workflows, tests, and generated contracts. Kodex is a Rust workspace with a React/TypeScript web app.

## Prerequisites

- Rust stable with `cargo` and `rustfmt`.
- Codex **0.160.0**, selected with `KODEX_CODEX_BINARY` or that exact version on `PATH`. Missing/unknown versions and failed initialization stop gateway startup.
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
KODEX_DATA_DIR="$(mktemp -d)/instance" KODEX_CODEX_BINARY=/absolute/path/to/codex cargo run -p kodex-gateway
```

Use disposable instances during the native redesign. The default new root is `~/.kodex/native-v1/`; `gateway.db` and `codex-home/` must stay inside the selected instance root. Startup refuses unrecognized existing state and takes an exclusive instance lock. Old state stays unopened, with no migration.

Start the web client in another terminal:

```bash
cd apps/web
npm install
npm run dev
```

Open `http://127.0.0.1:5173`. Vite proxies `/v1` and `/openapi.json` to `http://127.0.0.1:8787` by default.

To proxy to another local gateway, set `VITE_KODEX_PROXY_TARGET`. To call another gateway origin directly, set `VITE_KODEX_API_BASE_URL`.

App surfaces require a sandbox document on a different browser origin. Loopback development swaps `localhost` and `127.0.0.1` automatically. Remote browsers and HTTPS or non-loopback deployments must set `VITE_KODEX_APP_SURFACE_SANDBOX_URL` to the sandbox HTML on a distinct origin.

Sign in from **Account settings → Sign in with ChatGPT**. Kodex displays the native device code and verification link; app-server owns polling, expiry and authentication. This avoids the browser-login callback listener shared with Codex desktop. Cancellation targets the displayed native login ID, so cancelling an old attempt cannot cancel a newer attempt from another tab. Login remains global to this Kodex runtime.

Account state is reread after native account events, browser foreground checks and SSE reconnection. If a client misses a failed login's completion before receiving its first event cursor, the displayed attempt can remain waiting; cancel it and request a new code. Kodex does not add a durable login-status store or its own authentication poller.

Native approvals belong to the current app-server connection. Kodex mirrors outstanding requests in memory, deduplicates native replay, and refetches authoritative approval snapshots after invalidation, reconnection and browser foreground checks. Sending a response makes a request non-actionable while it waits for native resolution; a successful pipe write does not prove the decision was accepted or executed. A disconnected runtime retires its native requests. Generated-app grants remain gateway-owned and durable, with their existing scope checks.

Projects use native IDs, ordered roots and metadata. Roots organize a project; they do not create directories, grant workspace access or change an existing chat's working directory. New chats default to a project's sole root; projects with zero or multiple roots require a chosen execution directory. Configuration, permissions, skills and terminal context follow that choice. Changing project membership preserves chat history and its working directory; deleting a project leaves its chats unassigned. Kodex no longer provides direct database/rollout rewriting for moving old project paths.

Sidebar sections and their member order are native state. Pinned is the reserved native section; moving to Pinned replaces custom-section membership, and unpinning clears it. Sections appear in both sidebar scopes while project membership remains independent. Section headings use native list order; there is no native heading-reorder command. Successful gateway mutations emit a refill marker rather than a second persisted sidebar model. Browser reconnect and foreground checks recover changes missed by another tab.

Existing-chat controls edit shared native settings for the next turn using only the selected field. Send and Queue submit input and attachments without replaying browser settings. Native update acceptance is not application confirmation. Fresh chats expose full settings after their first native turn starts; unavailable reads refill at the canonical turn-start boundary. The pinned 0.160.0 native runtime restores model, reasoning effort and permission profile after restart, while service tier returns to the configured default. Kodex accepts that native behavior rather than preserving a duplicate settings record.

Execution defaults and MCP setup read the native config layers and expose only the active writable user target and opaque native version within the dedicated home. Forms capture that target when opened; writes use native `expectedVersion` with sparse edits. A conflict keeps the draft until explicit review replaces it with current native values. Secret replacement/deletion is an individual leaf edit; unchanged masks are never submitted. Unknown policies remain native-owned. Null removes a user-layer value, which can expose inherited configuration. Saved values overridden by higher layers are reported separately from effective values.

`config.changed` is a global refill-only event after a native save. Config reads are canceled/refilled on invalidation, actual EventSource reopening and foreground recovery. MCP writes request one explicit native reload after saving; failure leaves the save intact, and Reload retries only the runtime request. The acknowledgment establishes a queued refresh, not server readiness. Native config reload is best-effort for loaded chats and cannot turn session-static defaults into existing-chat settings.

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

Install its test browser once with `cd apps/web && npx playwright install chromium --only-shell`. The real app-server integration test is opt-in and uses a disposable home with a local Responses fixture, without existing credentials:

```bash
KODEX_TEST_CODEX_BINARY=/absolute/path/to/codex cargo test -p kodex-gateway --test native_app_server -- --ignored --nocapture
```

The native fixtures verify approval replay and exact resolution after acceptance/Stop; project roots, idempotent creation, sparse edits, order, membership and history after cold restart; shared settings and native sections; and native config CAS, missing-file versions, literal key paths, sparse secret/policy preservation and higher-layer overrides. Browser E2E covers two-tab approval/project/section/settings/config convergence, conflicts, missed notifications, delayed stale snapshots and real SSE reconnects. Responsive flows run at desktop, narrow fine-pointer and narrow touch sizes. Config proof servers are disabled, so these tests do not claim successful MCP authentication or server readiness. These fixtures do not establish completed interactive account sign-in or release readiness.

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

For contract generation without starting a runtime, export the same Rust definition and run the generator against that file:

```bash
cargo run -q -p kodex-gateway --example export_openapi > /tmp/kodex-openapi.json
cd apps/web
npx openapi-typescript /tmp/kodex-openapi.json -o src/api/generated/schema.ts
```

The output lives at `apps/web/src/api/generated/schema.ts`. Do not hand-write duplicate frontend DTOs or a separate route contract.

### Codex app-server schema

The checked-in schema is generated from the exact Codex binary used for compatibility testing, with experimental API output enabled. After changing Codex versions, run:

```bash
bash apps/gateway/scripts/generate-app-server-schema.sh 0.160.0 /absolute/path/to/codex
```

Keep the configured Codex binary version aligned with `apps/gateway/app-server-schema/<version>/VERSION`.

## Repository conventions

- Keep the browser a thin projection of gateway and app-server state.
- Put API calls in `api`, SSE behavior in `events`, and feature behavior in its closest frontend domain module.
- Treat generated OpenAPI and generated app-server schemas as contracts.
- Match tests to user-visible and shared-state risk; documentation-only changes do not require the code test suites.
- Keep local/private-network assumptions explicit in features and documentation.

Contributor workflow and detailed implementation constraints live in [`AGENTS.md`](../AGENTS.md). Active and completed implementation plans are indexed in [`plans/index.md`](../plans/index.md).
