# MCP Manager Plan

Status: Proposed.

## Context

Kodex should expose the Codex app-server MCP inventory in the web UI so users can inspect configured MCP servers, see available tools/resources, trigger OAuth login, reload MCP server configuration, and read concrete resources that app-server reports as available.

This plan intentionally keeps v1 narrower than a full MCP configuration editor. The gateway and app-server remain the source of truth; the browser is a projection of current MCP state plus short-lived UI state for selected rows, drawers, loading states, and resource previews.

Relevant code seams:

- The checked-in app-server schema already includes the MCP request/response contracts:
  - `apps/gateway/app-server-schema/0.128.0/json/v2/ListMcpServerStatusParams.json`
  - `apps/gateway/app-server-schema/0.128.0/json/v2/ListMcpServerStatusResponse.json`
  - `apps/gateway/app-server-schema/0.128.0/json/v2/McpResourceReadParams.json`
  - `apps/gateway/app-server-schema/0.128.0/json/v2/McpResourceReadResponse.json`
  - `apps/gateway/app-server-schema/0.128.0/json/v2/McpServerOauthLoginParams.json`
  - `apps/gateway/app-server-schema/0.128.0/json/v2/McpServerOauthLoginResponse.json`
  - `apps/gateway/app-server-schema/0.128.0/json/v2/McpServerStatusUpdatedNotification.json`
  - `apps/gateway/app-server-schema/0.128.0/json/v2/McpServerOauthLoginCompletedNotification.json`
- `apps/gateway/src/app_server_api.rs` is the existing typed adapter for app-server JSON-RPC requests. Its private `request` method validates every request through `apps/gateway/src/schema.rs`.
- Gateway route modules live under `apps/gateway/src/routes/`, are registered in `apps/gateway/src/routes/mod.rs`, and are exposed in OpenAPI through `apps/gateway/src/api.rs`.
- App-server notifications are ingested in `apps/gateway/src/events.rs` and currently persisted/broadcast as generic `codex.notification` events unless normalized into product-shaped events.
- Frontend API wrappers live in `apps/web/src/api/client.ts`, query keys in `apps/web/src/api/queryKeys.ts`, generated OpenAPI types in `apps/web/src/api/generated/schema.ts`, and event subscription wiring in `apps/web/src/events/stream.ts`.
- Preferences currently lives in `apps/web/src/PreferencesModal.tsx` with `appearance` and `plugins` sections. The existing Kodex Control plugin UI already summarizes plugin-provided MCP servers, but it does not inspect runtime MCP status.
- `plans/future-extensions.md` lists MCP manager as a future extension backed by `mcpServerStatus/list`, `mcpServer/resource/read`, `mcpServer/tool/call`, `mcpServer/oauth/login`, `mcpServer/oauthLogin/completed`, and `mcpServer/startupStatus/updated`.

## Current State

- Kodex has a gateway-hosted `kodex-control` MCP server in `apps/gateway/src/mcp.rs`, but that is a server exposed to Codex. It is not a web UI for app-server-managed MCP servers.
- The gateway has no `/v1/mcp/...` HTTP routes.
- The frontend has no MCP manager section, no MCP query keys, and no MCP API wrappers.
- `PreferencesModal` is small today but is the best existing home for global settings-like surfaces.
- `ConfigReadResponse` does not strongly type `mcp_servers`; it allows additional properties. Therefore `mcpServerStatus/list` must be canonical for v1 inventory, and `config/read` can only be optional best-effort enrichment if used at all.
- `AGENTS.md` requires generated OpenAPI as the public contract, frontend API types from generated artifacts, app-server schemas as the app-server source of truth, and multi-client convergence for shared lifecycle state.

## Settled Decisions

- V1 is inspect/auth/reload only.
- Do not support external-agent import.
- Do not support add, edit, delete, enable, or disable for MCP server config in v1.
- Do not expose `mcpServer/tool/call` or a tool tester in v1.
- Put the UI in a new global `MCP` section inside `PreferencesModal`.
- Keep plugin install/status UI separate in the existing `Plugins` section. The MCP manager may naturally show `kodex-control` in runtime inventory after the plugin is installed.
- Include read-only resource viewing for listed concrete resources from `mcpServerStatus/list`. Do not include arbitrary URI entry or resource-template expansion in v1.
- OAuth login is explicit: the frontend calls the gateway, receives `authorizationUrl`, and shows an "Open login" action using a normal browser link/button. The gateway must not run a local `open` command.
- Normalize raw app-server MCP payloads into Kodex gateway DTOs and OpenAPI schemas, while preserving flexible `serde_json::Value` fields for MCP schemas, resource contents, and metadata where the app-server contract intentionally allows arbitrary JSON.
- Require both manual Refresh and SSE-driven invalidation for `mcpServer/startupStatus/updated` and `mcpServer/oauthLogin/completed`.
- `mcpServerStatus/list` is canonical. Transport details from `config/read` are optional enrichment only, must be masked, and must not block inventory display.
- V1 is global only. Do not add project/cwd-scoped MCP views.

## Non-Goals

- Generic plugin marketplace UI.
- External migration wizard or calls to `externalAgentConfig/detect` / `externalAgentConfig/import`.
- MCP server config editor or TOML editor.
- MCP tool calling, argument editing, progress UI, or tool result history.
- Project-scoped effective config comparison.
- Browser-owned durable MCP state.

## Milestones

### 1. Gateway MCP Inventory API

Scope: `apps/gateway/src/app_server_api.rs`, new `apps/gateway/src/routes/mcp.rs`, `apps/gateway/src/routes/mod.rs`, `apps/gateway/src/api.rs`, backend route tests in `apps/gateway/src/routes/mod.rs`.

Work:

- Add typed app-server helpers for:
  - `mcpServerStatus/list`
  - `mcpServer/resource/read`
  - `mcpServer/oauth/login`
  - `config/mcpServer/reload`
- Add product-shaped gateway routes:
  - `GET /v1/mcp/servers?detail=toolsAndAuthOnly|full`
  - `GET /v1/mcp/servers/{server}/resources/read?uri=...`
  - `POST /v1/mcp/servers/{server}/oauth-login`
  - `POST /v1/mcp/reload`
- Page through `mcpServerStatus/list` until `nextCursor` is null. Use a conservative page size such as 100, matching upstream TUI behavior.
- Define gateway DTOs for server status, auth status, tools, resources, resource templates, resource read contents, OAuth login response, and reload response.
- Preserve arbitrary JSON for tool input/output schemas, `_meta`, annotations, resource contents, and structured MCP result data.
- Treat app-server status inventory as canonical. Do not require config enrichment in this milestone.
- Register the routes and schemas in `apps/gateway/src/api.rs` so `/openapi.json` exposes the public contract.

Exit criteria:

- Backend tests prove each route maps to the expected app-server method and params.
- A pagination test proves `GET /v1/mcp/servers` accumulates multiple `mcpServerStatus/list` pages.
- Route tests cover app-server unavailable/error behavior using existing error handling conventions.
- `cargo fmt` passes for touched Rust code.
- Focused backend tests pass.

### 2. MCP Lifecycle Events

Scope: `apps/gateway/src/events.rs`, `apps/web/src/events/stream.ts`, gateway event tests, frontend event/query invalidation tests.

Work:

- Normalize app-server `mcpServer/startupStatus/updated` notifications into a gateway event such as `mcp.server_status_updated`.
- Normalize app-server `mcpServer/oauthLogin/completed` notifications into a gateway event such as `mcp.oauth_login_completed`.
- Keep the existing generic `codex.notification` event for diagnostics, but make the normalized events easier for frontend cache invalidation.
- Add the new event kinds to `GATEWAY_SSE_EVENT_TYPES` in `apps/web/src/events/stream.ts`.
- Define frontend invalidation behavior so either normalized event invalidates the MCP servers query.

Exit criteria:

- Gateway tests ingest both app-server notification shapes and assert normalized events are persisted/broadcast.
- Frontend event-stream tests include the new event kinds.
- A focused frontend cache test proves MCP query invalidation happens after either normalized event.
- Two-tab correctness is covered at the test-shape level: one client can miss the OAuth/startup action and converge from SSE invalidation plus refetch.

### 3. Frontend API And Preferences Section

Scope: `apps/web/src/api/client.ts`, `apps/web/src/api/queryKeys.ts`, `apps/web/src/PreferencesModal.tsx`, new MCP-specific components if extraction is needed, `apps/web/src/styles/preferences.css`, `apps/web/src/PreferencesModal.test.tsx`, generated frontend schema.

Work:

- Regenerate `apps/web/src/api/generated/schema.ts` after Milestone 1.
- Add typed client wrappers for list servers, read resource, start OAuth login, and reload MCP.
- Add `queryKeys.mcpServers` and related keys if resource reads need separate query caching.
- Add an `MCP` section to `PreferencesModal`.
- Render a server list with name, auth status, tool count, resource count, template count, and clear empty/loading/error states.
- Add a Refresh button that refetches inventory.
- Add a Reload button that calls `POST /v1/mcp/reload`, then invalidates/refetches inventory.
- Add a server detail panel or drawer showing tools, resource list, resource templates, and auth state.
- For `notLoggedIn` / OAuth-capable servers, show a login action that calls `POST /v1/mcp/servers/{server}/oauth-login`, then presents the returned `authorizationUrl` as an explicit browser-open action.
- Keep the UI global. Do not require a selected project or thread.
- Extract MCP UI into a small module if `PreferencesModal.tsx` would become too large.

Exit criteria:

- `PreferencesModal` tests cover the new section navigation, inventory loading/error/empty states, server detail rendering, refresh, reload, OAuth URL presentation, and query invalidation.
- Frontend code uses generated OpenAPI types from `apps/web/src/api/generated/schema.ts`; no duplicate handwritten gateway DTOs.
- `cd apps/web && npm test -- PreferencesModal` or the closest focused test command passes.
- `cd apps/web && npm run build` passes.

### 4. Resource Viewer

Scope: MCP frontend components under the Preferences/MCP UI, resource read API wrapper tests, focused component tests.

Work:

- Let users open listed concrete resources returned in a server's `resources` array.
- Call `GET /v1/mcp/servers/{server}/resources/read?uri=...` for the selected resource.
- Render text and JSON-like resource contents in a readable, scrollable area.
- Show unsupported/binary/blob-like contents with metadata rather than attempting unsafe or broken previews.
- Do not support arbitrary URI input.
- Do not expand `resourceTemplates` in v1; list them as advertised capabilities only.

Exit criteria:

- Component tests cover successful text/JSON resource display, loading/error states, unsupported content fallback, and no arbitrary URI input.
- Long resource content remains scrollable without resizing or breaking the Preferences modal.
- Manual or browser validation confirms resource viewer content does not overlap controls at desktop and mobile widths.

### 5. Documentation And Validation

Scope: `plans/index.md`, `README.md` if implementation adds user-facing behavior, generated OpenAPI/frontend schema artifacts, focused browser validation.

Work:

- Keep `plans/index.md` status current when implementation starts/completes.
- Update `README.md` only when the implementation lands, with a short mention of Preferences > MCP if user-facing behavior is added.
- Regenerate frontend OpenAPI types after backend DTO changes.
- Run backend and frontend focused tests, then broader build/test commands appropriate to the touched scope.
- Use `$agent-browser` for UI validation after the MCP Preferences section is implemented.

Exit criteria:

- `cargo fmt` passes.
- Focused gateway route/event tests pass.
- `cd apps/web && npm test -- PreferencesModal` or closest focused test command passes.
- `cd apps/web && npm run build` passes.
- `$agent-browser` validates Preferences > MCP on desktop and mobile widths, including text fit, no overlapping controls, usable refresh/reload/login actions, and resource viewer scrolling.
- `README.md` is updated if the user-facing MCP manager ships.

## Verification

Implementation should use this minimum verification set, adjusted by the actual files touched:

- `cargo fmt`
- Focused backend tests for MCP routes and event normalization.
- Regenerate OpenAPI/frontend types after backend DTO changes.
- `cd apps/web && npm test -- PreferencesModal`
- `cd apps/web && npm run build`
- `$agent-browser` smoke validation for Preferences > MCP after UI implementation.

For lifecycle behavior, validate same-user two-tab convergence at least by test shape: after one client triggers OAuth or reload and app-server emits the corresponding notification, another client should receive the normalized SSE event, invalidate MCP inventory, and refetch from gateway/app-server state.

## Risks And Open Questions

- `config/read` does not strongly type `mcp_servers` in the checked-in `ConfigReadResponse` schema. If transport-detail enrichment becomes necessary, implement it as best-effort parsing with masking and focused tests; do not make it required for inventory.
- OAuth completion depends on app-server emitting `mcpServer/oauthLogin/completed`. The UI should also leave manual Refresh available because browser auth redirects may complete outside the current tab.
- Resource contents can be arbitrary MCP content. The viewer must avoid assuming plain text and must degrade cleanly for binary/blob/resource-link variants.
- `config/mcpServer/reload` may change runtime state for all tabs. Treat reload as an explicit user action and rely on app-server notifications plus manual refetch for convergence.
- Future config mutation requires a separate plan because it needs write-target policy, secret handling, name validation, conflict handling, and reload semantics.
