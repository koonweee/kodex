# Federation baseline audit

Date: 2026-10-12  
Pinned source: `496eb35aae3e25786633c4d2ab8b356f809f430f`

This audit fixes the behavioral baseline for the Federated Kodex plan before service ownership moves. It is an implementation checklist, not a second API contract. Rust DTOs and generated OpenAPI remain the public contract.

## Current ownership and runtime inventory

The gateway bootstrap owns one app-server child, native ingest, app-surface import, queue-transfer recovery, automation recovery and scheduling, terminal cleanup, notification delivery and one HTTP listener. Its `AppState` combines native/gateway execution state with browser notification delivery. The initial split therefore keeps every native and host capability in the executor and moves only federation state, browser assets and provider delivery into the new service.

Current route ownership is defined by the router constructors under `apps/gateway/src/routes`, plus queue and event routes. The browser API includes health/capabilities, projects/directories, threads/history/subagents, turns/queue/goals/settings, approvals, terminals, files/uploads, account/models/usage, skills/permissions, MCP/plugins, app surfaces, automations, notifications/presence and frontend-update events. Thirty-seven `/v1/self-control` routes are agent-facing and must be reachable only through the executor's loopback Control listener. The generated executor OpenAPI inventory excludes those local-only routes and guards against silently dropping browser routes during proxying.

Browser URL construction is currently concentrated in `api/client.ts`, `events/stream.ts`, terminal panes, file-preview helpers, skill icon helpers, service-worker notification code and app-surface document/sandbox resolution. `GatewayInstanceBoundary`, the singleton query client/query keys, workspace pane targets and browser routes all assume one executor. These are the required M3 migration points; feature components must not construct federation paths independently.

| State or worker | Baseline owner | Federated owner |
| --- | --- | --- |
| App-server process, ingest and canonical thread projection | Gateway | Executor |
| Native approvals, settings, goals, projects, pins and queues | App-server/gateway connection | Executor |
| Queue-transfer recovery, app artifacts/grants and read state | Gateway database | Executor database |
| Automation schedule/recovery and PTY cleanup | Gateway process/database | Executor process/database |
| Eligible completion delivery records and exact-turn preview reads | Gateway database/native app-server | Executor database/native app-server |
| Browser push subscriptions, VAPID provider send and test notifications | Gateway database/process | Federator database/process |
| Frontend update events and static/sandbox assets | Gateway | Federator |
| Executor registry, cross-executor order and stale catalog | Absent | Federator database |
| Drafts, focus, pane layout and scroll | Browser | Browser, executor-qualified |

## Contract direction and network boundary

The executor retains its existing `/v1` DTOs and generated schema. Its federation-facing router excludes `/v1/self-control` and static frontend fallback. A second loopback listener exposes only `/v1/self-control`; the managed app-server child receives that listener through `KODEX_GATEWAY_URL`. The transitional combined router may exist only while tests/callers are migrated and must be removed before M8.

The federator owns new Rust DTOs for registry, catalog/order, aggregate status/badge and diagnostic notifications. Browser proxy paths are qualified by the federator's stable executor binding ID. The federator validates the expected executor instance on every routed operation; browser-supplied URLs never select proxy destinations.

Registration accepts HTTPS base URLs without userinfo, query or fragment whose resolved address is in the Tailscale CGNAT range `100.64.0.0/10` or Tailscale ULA prefix `fd7a:115c:a1e0::/48`. A co-located executor may use loopback HTTP. Redirects are disabled. Resolution and peer validation are repeated when connecting so a saved hostname cannot bypass endpoint policy after DNS changes. Other private, LAN and public targets are out of scope.

The intended Tailscale policy grants browser devices access to the federator primary and sandbox HTTPS services, and grants only the federator node access to executor federation ports. Control ports stay loopback-only and are never published by Tailscale Serve. Exact node tags/names remain operator configuration and are documented in M7 rather than hard-coded by Kodex.

## Preservation evidence

| Federated acceptance area | Closest baseline evidence to retain or extend |
| --- | --- |
| Native attach, lifecycle, revert and projection fencing | `native-history.spec.ts`, `native-revert.spec.ts`, gateway `native_*` route tests and thread-view tests |
| Start/steer/queue and ambiguous promotion | queue-transfer HTTP/reconciliation tests, composer MVP tests and native queue Playwright flows |
| Native approvals and connection reset | approval route tests and `App.mvp.approvals-stream.test.tsx` |
| Project/pin/sidebar convergence | native project/pin tests, sidebar cache tests and two-tab project Playwright flows |
| Sparse settings/config conflicts | native settings/config tests and `native-config.spec.ts` |
| App surfaces and grants | gateway app-surface route/import tests, `App.appSurface.test.tsx` and native MCP widget proof |
| Files, ranges and terminal WebSockets | file-preview tests/browser proof and native terminal Playwright proof |
| Notification retry, stale endpoints and foreground suppression | store notification reclaim test, gateway notification tests, route notification tests and `native-pwa.spec.ts` |
| Account device-code normalization | `app_server_api::tests::login_start_normalization_requires_a_complete_native_device_code` and native device-code Playwright proof |
| MCP OAuth request/completion and retained credentials | gateway MCP route tests and `native_app_server/mcp_auth.rs`; remote callback forwarding needs a separate M5 proof |
| Instance replacement and browser draft safety | `GatewayInstanceBoundary.test.tsx` until replaced by per-executor connection tests |
| Responsive editing continuity | responsive contract Playwright matrix and composer component tests |

New federation tests use two executor fixtures with deliberately colliding native IDs. Same-user two-tab tests cover every shared federator mutation. Baseline tests remain in place until equivalent qualified coverage exists; test deletion requires demonstrating which new test protects the same user-visible guarantee.

## Native and notification baseline

The pinned generated app-server schema is `0.160.0`. Device-code account login is `account/login/start` with `type: chatgptDeviceCode`. MCP login is `mcpServer/oauth/login`; its completion notification does not make the browser-to-executor callback reachable. Manual native callback configuration/forwarding remains required and must be demonstrated on a remote executor before M5 exits.

Current notification delivery persists a job before provider work, reclaims stale processing, retries temporary failures at bounded attempts, remembers subscriptions already sent during partial success, disables endpoints only after a permanent provider response, suppresses foreground/read/ineligible work and reads the exact native turn for previews. Federation must move provider/subscription ownership without changing those guarantees or reconstructing missing jobs from transcript history.

## Platform evidence at baseline

The available validation host is macOS 27.0.1 on ARM64. The service tool pins verified Codex 0.160.0 packages for macOS ARM64 and x86-64, but only the current ARM64 host can provide a real lifecycle proof here. The pinned checkout has no Linux package digests, systemd installer or available Linux validation host recorded.

M7 must add exact verified Linux package data and obtain real Ubuntu/Debian-family systemd evidence. macOS x86-64 and both Linux architecture combinations remain unsupported until their evidence rows pass. Unit mocks or successful compilation do not change that status.

## M0 progress record

The ownership inventory, preservation map, Rust contract direction, endpoint policy and available platform evidence are recorded. The executor/Control route split begins with a failing boundary test and retains the current notification/account/MCP characterization tests. The required remote-executor MCP OAuth callback proof is still pending, so this is not an M0 exit record. No running service, user storage, deployment or production URL was changed.
