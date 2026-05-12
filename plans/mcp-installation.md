# MCP Installation Plan

Status: Complete.

## Context

Kodex already exposes a read-only MCP manager in Preferences > MCP. The next step is to let users install and manage global MCP servers from the UI, matching the practical scope of `codex mcp add/remove/list` while respecting Kodex's gateway-owned state and generated API contract.

Codex CLI's MCP management path operates on global config. The upstream CLI supports `codex mcp list|get|add|remove|login|logout`; `add` validates a server name, constructs either a stdio or streamable HTTP transport, writes the global `mcp_servers` config table, and can initiate OAuth for HTTP servers. We will not shell out to the CLI. Kodex should use the app-server config APIs that are already part of the checked-in schema.

Relevant code seams:

- `apps/gateway/src/routes/mcp.rs` currently exposes read/runtime routes: `GET /v1/mcp/servers`, resource read, OAuth login, and reload.
- `apps/gateway/src/app_server_api.rs` wraps `mcpServerStatus/list`, `mcpServer/resource/read`, `mcpServer/oauth/login`, `config/mcpServer/reload`, `config/read`, and `config/batchWrite`.
- `apps/gateway/app-server-schema/0.128.0/json/v2/ConfigBatchWriteParams.json` supports `edits`, `filePath`, `expectedVersion`, and `reloadUserConfig`; `ConfigReadResponse.json` includes config layer metadata but leaves `mcp_servers` loose through additional properties.
- `apps/gateway/src/events.rs` already emits operational MCP lifecycle events: `mcp.server_status_updated` and `mcp.oauth_login_completed`.
- `apps/web/src/mcp/McpPreferencesPanel.tsx` renders the Preferences > MCP inventory, reload/refresh controls, OAuth login, and resource viewer.
- Frontend API wrappers and generated types live in `apps/web/src/api/client.ts`, `apps/web/src/api/generated/schema.ts`, and `apps/web/src/api/queryKeys.ts`.
- The current cache invalidation helper in `apps/web/src/api/mcpCache.ts` invalidates runtime MCP inventory on MCP lifecycle events.

## Current State

- Runtime MCP inventory is canonical for loaded server status. It comes from `mcpServerStatus/list` and includes auth status, tools, resources, and resource templates.
- Configured MCP entries are not currently exposed by the gateway. They must be parsed best-effort from global `config/read`; the checked-in app-server schema does not strongly type `mcp_servers`.
- Preferences > MCP has no Add, Remove, Enable, Disable, or Replace actions.
- The existing MCP plan explicitly excluded config mutation. This plan is a follow-up, not a change to the completed read-only milestone.
- `AGENTS.md` requires public request/response DTOs to be generated through backend OpenAPI and frontend generated types.
- Shared settings that affect other tabs must be gateway-owned and convergent through SSE/cache invalidation.

## Settled Decisions

- V1 is global-only, matching `codex mcp add` writing global user config.
- V1 supports add, remove, enable/disable, and explicit replace for existing names.
- Full granular edit is deferred.
- Supported transports are stdio command and streamable HTTP.
- Manual form only. No MCP catalog, presets, marketplace, or external-agent import.
- No preflight/test-connection endpoint. Save config, reload MCP, then show runtime status.
- Add/remove/replace/toggle mutations emit `mcp.config_changed`.
- After successful config mutation, the gateway calls `config/mcpServer/reload` and frontend refetches configured and runtime MCP data.
- OAuth remains explicit. The UI waits for the user to click Log in after install instead of auto-starting OAuth.
- Inline stdio env values and HTTP header values are allowed, with warning icon/tooltips and confirmation copy.
- The gateway masks secret values on readback. The browser must never receive stored inline secret values from config reads.
- Existing secret fields render as configured status with explicit Replace and Clear actions, not fake masked inputs.
- Replacing an existing server with stored secret values requires confirmation and writes exactly the submitted config.
- Enable/disable only patches `mcp_servers.<name>.enabled` and must preserve hidden secret values.
- Remove requires confirmation for every server and calls out stored env/header values when present.
- Remove deletes inline env/header secrets because it removes the config entry. It does not delete app-server-owned OAuth credentials unless a supported app-server MCP OAuth logout/delete API becomes available.
- One merged server list is preferred, but source labels must be evidence-based: Configured from parsed config, Loaded from runtime status, Plugin-provided only when plugin metadata proves it.
- Any local stdio command is allowed, with a warning that Codex will run it locally when loading the MCP server.

## Non-Goals

- Project-scoped MCP config writes.
- Arbitrary TOML editor.
- MCP tool tester or `mcpServer/tool/call`.
- External-agent import.
- MCP preset catalog or curated third-party recommendations.
- App-server OAuth credential deletion unless an upstream schema/API is added and verified.
- Gateway SQLite storage for MCP secrets.

## Milestones

### 1. Config DTOs And Safe Parsing

Scope: `apps/gateway/src/app_server_api.rs`, `apps/gateway/src/routes/mcp.rs`, `apps/gateway/src/api.rs`, backend route tests in `apps/gateway/src/routes/mod.rs`.

Work:

- Add typed gateway DTOs for configured MCP entries:
  - `ConfiguredMcpServer`
  - `ConfiguredMcpTransport` with `stdio` and `streamableHttp`
  - `ConfiguredMcpSecret` or equivalent structured secret metadata with `configured`, `masked`, and optional replacement/clear status.
  - `McpServerSource` / status evidence fields for `configured`, `loaded`, and `pluginProvided` where provable.
- Add request DTOs for add/replace/toggle/remove:
  - `McpServerInstallRequest`
  - `McpServerTransportRequest`
  - `McpSecretInput` for inline secret values, env var references, replace, clear, and unchanged semantics.
  - `McpServerToggleRequest`.
- Add config parsing helpers that read global `config/read` and best-effort parse `config.mcp_servers`.
- Mask inline secret-bearing fields before returning data:
  - stdio `env` values.
  - HTTP headers / env HTTP headers values when represented as inline values.
  - any future secret-shaped field added to the DTO.
- Preserve non-secret config metadata needed by the UI: name, enabled, command, args, URL, bearer token env var, env var names, header names, timeout fields, required flag, scopes.
- Do not parse project/cwd config layers for v1 writes.

Exit criteria:

- Backend unit/route tests prove configured server reads parse stdio and HTTP entries.
- Tests prove secret values are not returned by any configured-server response.
- Tests cover malformed/unknown `mcp_servers` entries degrading without panics.
- OpenAPI includes the new DTOs and routes.

### 2. Gateway MCP Config Mutation API

Scope: `apps/gateway/src/app_server_api.rs`, `apps/gateway/src/routes/mcp.rs`, `apps/gateway/src/events.rs`, `apps/gateway/src/routes/mod.rs`, `apps/gateway/src/api.rs`.

Work:

- Add gateway routes:
  - `GET /v1/mcp/configured-servers`
  - `POST /v1/mcp/servers`
  - `POST /v1/mcp/servers/{server}/replace`
  - `PATCH /v1/mcp/servers/{server}/enabled`
  - `DELETE /v1/mcp/servers/{server}`
- Validate names before writing config. Use a conservative name grammar compatible with Codex CLI expectations: ASCII letters, digits, `_`, and `-`; reject empty names and path-like input.
- Add app-server adapter helpers for config mutation:
  - global `config/read includeLayers:true` for readback/version metadata.
  - `config/batchWrite` with key paths under `mcp_servers.<name>`.
  - `config/mcpServer/reload` after successful writes.
- Add operations:
  - Add: reject existing configured name unless explicitly replacing.
  - Replace: write the full submitted entry and require frontend confirmation when stored secret values exist.
  - Toggle: write only `mcp_servers.<name>.enabled` and preserve all other fields.
  - Remove: remove/null the `mcp_servers.<name>` entry using the app-server-supported config edit shape; confirm exact deletion behavior against schema/tests before implementation.
- Emit a persisted/broadcast `mcp.config_changed` event after successful mutation, before or after reload as appropriate, with payload that includes operation and server name but no secret values.
- Add `mcp.config_changed` to operational replay/live SSE filters in `apps/gateway/src/events.rs`.
- Return a product-shaped mutation response with the updated configured entry, reload result, and best-effort runtime status if available.

Exit criteria:

- Route tests prove each mutation maps to the expected `config/batchWrite` params.
- Tests prove toggle writes only the `enabled` key path.
- Tests prove replace and remove never echo secret values.
- Tests prove `mcp.config_changed` is replayed and delivered over live SSE.
- Tests prove reload is attempted after successful config writes and errors are surfaced with existing gateway error conventions.

### 3. Frontend API, Query Keys, And Cache Convergence

Scope: `apps/web/src/api/client.ts`, `apps/web/src/api/queryKeys.ts`, `apps/web/src/api/mcpCache.ts`, `apps/web/src/events/stream.ts`, generated `apps/web/src/api/generated/schema.ts`, focused frontend tests.

Work:

- Regenerate OpenAPI TypeScript after backend DTO/route changes.
- Add typed client wrappers for configured-server read and add/replace/toggle/remove mutations.
- Add query keys:
  - `queryKeys.mcpConfiguredServers`
  - merged MCP view key if implemented as a frontend selector.
- Extend `GATEWAY_SSE_EVENT_TYPES` and `applyMcpLifecycleEvent` to include `mcp.config_changed`.
- Invalidate configured and runtime MCP queries on:
  - `mcp.config_changed`
  - `mcp.server_status_updated`
  - `mcp.oauth_login_completed`
- Add a two-client test shape for config mutation convergence: one QueryClient mutates, another observes `mcp.config_changed`, invalidates, and refetches.

Exit criteria:

- Frontend tests prove `mcp.config_changed` invalidates all MCP query keys.
- Generated schema is committed and no duplicate handwritten gateway DTOs are introduced.
- `cd apps/web && npm test -- --run src/api/mcpCache.test.ts src/events/stream.test.ts` passes.

### 4. Preferences > MCP Install UX

Scope: `apps/web/src/mcp/McpPreferencesPanel.tsx`, likely extracted MCP form/list modules under `apps/web/src/mcp/`, `apps/web/src/PreferencesModal.test.tsx`, `apps/web/src/styles/preferences.css`.

Work:

- Split the current MCP panel before it grows too large:
  - inventory/list component.
  - detail/resource component.
  - install/replace modal component.
  - secret row editor component.
- Render one merged row per server name using configured entries plus runtime status.
- Display evidence-based labels:
  - `Configured` when present in parsed config.
  - `Loaded` when present in runtime status.
  - `Plugin-provided` only when known plugin metadata proves it.
- Show manage actions only when a row is user-configured:
  - Enable/Disable.
  - Remove.
  - Replace.
- Add `Add server` modal:
  - name.
  - transport segmented control: HTTP / Local command.
  - HTTP fields: URL, bearer token env var, advanced headers.
  - stdio fields: command, args, cwd, env rows.
  - advanced fields: enabled, required, startup timeout, tool timeout, scopes.
  - warning icon/tooltips for inline env/header values and local command execution.
- Secret UX:
  - existing inline secrets show as configured, not as values.
  - Replace opens an empty password field.
  - Clear sends explicit clear semantics.
  - unchanged secrets are omitted from mutation payloads.
- Confirmations:
  - saving a stdio server confirms local command execution.
  - replacing an existing server with stored secrets confirms hidden secrets may be replaced or cleared.
  - removing any server confirms deletion; stored-secret copy appears when relevant.
- Keep OAuth explicit after install: show the existing Log in action when runtime auth status requires it.

Exit criteria:

- Component tests cover add stdio, add HTTP, inline secret warnings, configured secret readback, replace, clear, toggle, remove confirmation, and runtime/config merge labels.
- Tests prove no stored secret value appears in rendered UI after readback.
- Existing resource viewer tests remain passing.
- `cd apps/web && npm test -- --run src/PreferencesModal.test.tsx` passes.

### 5. Documentation, Validation, And Rollout

Scope: `README.md`, `plans/index.md`, `plans/mcp-installation.md`, generated artifacts, browser validation.

Work:

- Update README route list with MCP config mutation routes after implementation lands.
- Keep `plans/index.md` status current.
- Document local-only security posture:
  - inline values are stored in local Codex config, not gateway SQLite.
  - UI masks readback but this is not a secure secret manager.
  - stdio MCP commands run locally when Codex loads the server.
  - app-server-owned OAuth credentials are not removed by v1 delete unless upstream exposes a supported logout/delete API.
- Use `$agent-browser` to validate Preferences > MCP:
  - desktop and mobile.
  - add HTTP server form.
  - add stdio server form.
  - warning tooltip on secret/local-command icons.
  - confirmations.
  - merged row labels and actions.
  - no overlap or text overflow.

Exit criteria:

- `cargo fmt` passes.
- Focused gateway route/event tests pass.
- Focused frontend MCP/Preferences tests pass.
- `cd apps/web && npm run build` passes.
- `$agent-browser` validates the UI flows at desktop and mobile widths.
- Independent review pass finds no major issues.

## Verification

Minimum verification set:

- `cargo fmt`
- Focused backend tests for MCP config read/mutation routes and `mcp.config_changed` replay/live SSE.
- Regenerate frontend OpenAPI types with a gateway running, then `cd apps/web && npm run generate:api`.
- `cd apps/web && npm test -- --run src/PreferencesModal.test.tsx src/api/mcpCache.test.ts src/events/stream.test.ts`
- `cd apps/web && npm run build`
- `$agent-browser` smoke and responsive validation for Preferences > MCP install/remove/toggle/replace flows.

Two-tab correctness must be tested at the query/cache layer: a config mutation in one client emits `mcp.config_changed`; another active client invalidates configured and runtime MCP queries and refetches gateway-owned state.

## Completion Notes

- Implemented global MCP configured-server read plus add, replace, enable/disable, and remove routes.
- Added gateway-masked configured-server responses and explicit replace/clear semantics for stored inline env/header values.
- Added Preferences > MCP add/replace UI with stdio, streamable HTTP, advanced fields, warning tooltips, confirmations, and stored-secret rows.
- Added `mcp.config_changed` replay/live SSE handling and frontend cache invalidation for configured/runtime MCP queries.
- Updated README security notes for local config secrets, stdio command execution, and OAuth credential deletion limits.

## Risks And Open Questions

- `ConfigReadResponse` does not strongly type `mcp_servers`; parsing must remain defensive and tested against unknown fields.
- Confirm the exact app-server-supported deletion shape for removing `mcp_servers.<name>` before implementing remove. If `config/batchWrite` cannot delete a nested table cleanly, use the smallest supported replace/upsert strategy and cover it with backend tests.
- App-server-owned MCP OAuth credentials remain after config deletion unless a supported MCP logout/delete API appears in the schema.
- Inline secret values improve UX but create plaintext local config entries. The warning copy and masking must be honest: this is local config management, not secret vaulting.
- Runtime inventory may lag after reload or contain plugin-provided servers that are not editable through user config. The UI must avoid overstating source provenance.
- Any future project-scoped MCP config needs a separate plan because write target, layer conflicts, and multi-tab convergence are different.
