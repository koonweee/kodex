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

To proxy to another local gateway, set `VITE_KODEX_PROXY_TARGET`. To call another gateway origin directly, set `VITE_KODEX_API_BASE_URL`. Service-worker registration and Web Push require the frontend and API to share an origin; they are disabled when this variable points to a different origin. Use the Vite proxy for development PWA badge and notification checks.

App surfaces require a sandbox document on a different browser origin. Loopback development swaps `localhost` and `127.0.0.1` automatically. Remote browsers and HTTPS or non-loopback deployments must set `VITE_KODEX_APP_SURFACE_SANDBOX_URL` to the sandbox HTML on a distinct origin.

Sign in from **Account settings → Sign in with ChatGPT**. Kodex displays the native device code and verification link; app-server owns polling, expiry and authentication. This avoids the browser-login callback listener shared with Codex desktop. Cancellation targets the displayed native login ID, so cancelling an old attempt cannot cancel a newer attempt from another tab. Login remains global to this Kodex runtime.

Device-code authentication must be enabled in personal ChatGPT security settings or by the workspace administrator. Issuing a code does not establish whether the eventual account is eligible. Cancellation stops this native login attempt; it does not revoke the provider-issued code. See [Codex authentication guidance](https://learn.chatgpt.com/docs/auth).

Account state is reread after native account events, browser foreground checks and SSE reconnection. If a client misses a failed login's completion before receiving its first event cursor, the displayed attempt can remain waiting; cancel it and request a new code. Kodex does not add a durable login-status store or its own authentication poller.

Native approvals belong to the current app-server connection. Kodex mirrors outstanding requests in memory, deduplicates native replay, and refetches authoritative approval snapshots after invalidation, reconnection and browser foreground checks. Sending a response makes a request non-actionable while it waits for native resolution; a successful pipe write does not prove the decision was accepted or executed. A disconnected runtime retires its native requests. Generated-app grants remain gateway-owned and durable, with their existing scope checks.

Projects use native IDs, ordered roots and metadata. Roots organize a project; they do not create directories, grant workspace access or change an existing chat's working directory. Browser project creation selects one existing directory inside the gateway user's home and derives the project name from it. New project chats and project terminals use the sole root; projects with zero or multiple roots must be corrected before execution. Configuration, permissions and skills follow that root. Existing chats cannot be reassigned to a project through Kodex. Deleting a project leaves its chats unassigned. Kodex no longer provides direct database/rollout rewriting for moving old project paths.

Pinned membership and order are native state. The UI exposes pin/unpin and pinned ordering, with no custom section management or section caches. Existing native custom-section membership does not filter chats out of normal project/chat lists. Pin operations preserve project membership and working directory. Successful gateway mutations emit a refill marker; browser reconnect and foreground checks recover changes missed by another tab.

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

Most Playwright flows use gateway projection fixtures and start Vite on `127.0.0.1:5174`. The native terminal and built-PWA flows instead start the actual gateway and pinned Codex in disposable instances, serving a copied production bundle. They never use existing credentials or production storage.

Install its test browser once with `cd apps/web && npx playwright install chromium --only-shell`. The real app-server integration test is opt-in and uses a disposable home with a local Responses fixture, without existing credentials:

```bash
KODEX_TEST_CODEX_BINARY=/absolute/path/to/codex cargo test -p kodex-gateway --test native_app_server -- --ignored --nocapture
```

The built-PWA and native-terminal browser tests use full Chromium because the separate headless shell crashes on this worker's BadgeService binding. Run them explicitly after building both applications:

```bash
cargo build -p kodex-gateway
cd apps/web
npm run build
npx playwright install chromium --no-shell
KODEX_TEST_GATEWAY_BINARY="$PWD/../../target/debug/kodex-gateway" KODEX_TEST_CODEX_BINARY=/absolute/path/to/codex npm run test:e2e -- tests/native-terminal.spec.ts tests/native-pwa.spec.ts --workers=1
```

These tests are skipped without both explicit binary paths. The terminal proof uses real shells and WebSockets in two tabs at all three viewport/input shapes. The PWA proofs exercise a real worker, static CacheStorage, network-owned APIs/uploads/file previews and an explicit waiting-worker update. A browser-dispatched trusted Push reaches the worker without a subscription; Chromium records the native notification display, and the worker reads the current gateway badge rather than trusting the pushed count. This is browser/worker compatibility evidence, not provider delivery, notification click or OS badge-display evidence. The Rust native terminal proof stops and explicitly replaces app-server while the same gateway shell continues; it does not claim automatic app-server recovery or terminal persistence across gateway restart.

An additional manual-only provider proof requires an installed Google Chrome executable and outbound access to its push service. Its `.manual.ts` file is excluded from normal Playwright discovery, including when the Chrome environment variable is inherited. After the same builds, run it from a terminal opened by the user, outside gateway-launched agent commands:

```bash
KODEX_TEST_GATEWAY_BINARY="$PWD/../../target/debug/kodex-gateway" KODEX_TEST_CODEX_BINARY=/absolute/path/to/codex KODEX_TEST_CHROME_BINARY=/absolute/path/to/google-chrome npm run test:push-provider:manual
```

On macOS, installed Chrome startup can trigger App Management protection for Chrome’s own bundle. When launched through a gateway agent, macOS names `kodex-gateway` as the responsible parent in the alert. Keep routine Playwright and agent-browser checks on bundled Chromium; agents should leave this installed-Chrome proof to the user.

This proof creates temporary VAPID keys and a disposable persistent Chrome profile, registers a genuine subscription, and sends the actual gateway Test notification with the page backgrounded. It first observes trusted Push and Chrome's native notification display in the active worker. It then stops that worker through the browser, confirms the stopped state, and sends another real notification without navigating or requesting a worker start. A second native display and the same worker version running prove cold-worker wake. No Push event is injected and the provider is not mocked. Notification permission is pre-granted, so permission prompts remain untested. Sanitized JSON evidence is saved in the test's output directory. Cleanup disables/unsubscribes the temporary endpoint and removes the profile and gateway instance. It is skipped without the explicit Chrome and native binary paths; provider outages fail the opted-in test. This establishes loopback provider delivery and wake, not OS installation, notification clicks, badge display or delivery on the intended mobile/VPN deployment.

The real device-code UI proof also requires explicit opt-in and outbound access to the authentication provider. After the same builds, run:

```bash
KODEX_TEST_GATEWAY_BINARY="$PWD/../../target/debug/kodex-gateway" KODEX_TEST_CODEX_BINARY=/absolute/path/to/codex KODEX_TEST_REAL_DEVICE_CODE_LOGIN=1 npm run test:e2e -- tests/native-device-code.spec.ts --workers=1
```

This test issues a real code through the Account dialog and immediately cancels that exact login. It observes native completion through an already-open SSE stream, verifies that the account remains absent and no `auth.json` is created, and removes its owned runtime. It never opens the verification page or authorizes an account. Screenshots, traces and videos are disabled, code assertions return only booleans, and a worker-scoped guard suppresses automatic failure accessibility snapshots through teardown; saved JSON evidence contains only sanitized scope/results. Without the explicit opt-in and both binary paths it is skipped; provider failures fail the opted-in run. Issuance and local cancellation do not prove account eligibility, authenticated sign-in, credential reuse after restart or managed-account storage isolation.

The native fixtures also verify approval replay/resolution, projects/settings/pins/config, queue admission and promotion, history, read state, installed Control, scoped hosted widgets and MCP OAuth. OAuth and hosted-widget proofs use local synthetic services; they establish native callback/token/resource compatibility rather than real provider consent. Browser E2E covers two-tab convergence, conflicts, missed notifications, delayed stale snapshots and real SSE reconnects. Responsive flows run at desktop, narrow fine-pointer and narrow touch sizes. These fixtures do not establish completed interactive Codex account sign-in, OS PWA installation, mobile Safari behavior, target-device Web Push delivery, operator VPN/TLS setup or release readiness.

## Responsive UI ownership

Responsive layout follows the available surface: the shared workspace breakpoint controls navigation, while each `PaneLayout` boundary provides independent pane-width and pane-height classifications through `data-pane-width`, `data-pane-height` and `usePaneLayout()`. Compact panes reuse the compact composer and accessory treatment on both mouse and touch devices. Shared input capabilities separately control ergonomics and hover alternatives; primary fine hover and available touch/coarse input can coexist. Automatic composer expansion requires actual touch opening in a narrow browser window. Mouse, keyboard focus and narrow columns inside a wide workspace stay inline. Keyboard-submit behavior retains its existing policy.

Keep pane styling scoped to its intended boundary and pass policies explicitly to pane-owned portals. Browser geometry remains appropriate for placement, and global dialogs may use viewport-fit rules. `npm run trim:responsive` runs the architecture checker and its fixture tests; the normal frontend trim command includes it. The checker rejects feature-local responsive detection and viewport-fit rules in migrated pane styles, while browser acceptance tests establish that each surface uses the correct axis. See the [responsive UI contract](../plans/responsive-ui-contract.md) and [contributor guidance](../AGENTS.md#frontend-responsive-styling) for the required combination and editing-continuity checks.

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

Regenerate the committed frontend types from the checkout’s Rust exporter; no running gateway is required:

```bash
cd apps/web
npm run generate:api
```

The command exports into a temporary file and generates types from it, so a stale installed server cannot influence the contract.

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
