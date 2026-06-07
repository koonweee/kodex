# MCP App Surfaces Plan

## Status

Complete as of June 7, 2026. The implementation hard-cuts generated app surfaces onto the MCP Apps protocol, removes generated UI public routes/tools/storage, updates the bridge to spec-shaped JSON-RPC methods, stores full app-surface metadata, adds the web sandbox proxy, rejects legacy submit HTML, refreshes OpenAPI/frontend types, and updates Kodex Control guidance. The "Current State" section below is retained as pre-implementation planning context.

This revision is the P0 hard-cut compliance plan. The target is to make external MCP Apps and Kodex-generated app surfaces use one MCP Apps protocol. Legacy generated UI routes, generated UI event types, `kodex.generatedUi.submit` messages, and submit-only helpers are not preserved. Existing generated HTML may be discarded.

## Goal

Make Kodex a practical MCP Apps host for the stable 2026-01-26 `io.modelcontextprotocol/ui` extension:

- External MCP Apps should run unchanged when they use standard `text/html;profile=mcp-app` resources and JSON-RPC bridge methods.
- Kodex-generated app surfaces should be host-originated MCP Apps: generated HTML stored as an MCP App resource and communicating only through MCP Apps JSON-RPC.
- Generated surfaces may receive a tiny injected helper only if it emits standard MCP Apps JSON-RPC messages. The host must not accept old Kodex submit event protocols.
- Spec compliance and a unified protocol are more important than compatibility with previously generated local HTML.

## Spec Baseline

Use the stable MCP Apps specification dated 2026-01-26 as the implementation baseline:

- Extension identifier: `io.modelcontextprotocol/ui`.
- Supported MIME type: `text/html;profile=mcp-app`.
- Tool linkage: `_meta.ui.resourceUri`.
- Resource metadata: `_meta.ui.csp`, `_meta.ui.permissions`, `_meta.ui.domain`, `_meta.ui.prefersBorder`.
- View transport: JSON-RPC 2.0 over `postMessage`.
- Core view-to-host methods: `ui/initialize`, `tools/call`, `resources/read`, `ui/message`, `ui/update-model-context`, `ui/open-link`, `ui/request-display-mode`, `ping`, and `notifications/message`.
- Host-to-view notifications and lifecycle: `ui/notifications/initialized`, `ui/notifications/tool-input`, `ui/notifications/tool-result`, `ui/notifications/tool-cancelled`, `ui/notifications/size-changed`, `ui/notifications/host-context-changed`, and `ui/resource-teardown`.
- Web hosts must use a sandbox proxy on a different origin before loading untrusted app HTML.

References:

- `https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx`
- `https://modelcontextprotocol.io/extensions/apps/overview`

## Current State

Backend:

- `apps/gateway/src/app_server.rs::initialize_params` already advertises `io.modelcontextprotocol/ui` with `text/html;profile=mcp-app`.
- `apps/gateway/src/app_surfaces.rs` parses `_meta.ui.resourceUri`, defaults visibility to `["model", "app"]`, filters app-visible tools, accepts only text HTML, and stores only `connectDomains` and `resourceDomains` in `AppSurfaceCsp`.
- `apps/gateway/src/routes/app_surfaces.rs` exposes `GET /v1/threads/{threadId}/app-surface`, `GET /v1/app-surfaces/{sessionId}/document`, and `POST /v1/app-surfaces/{sessionId}/bridge`.
- The current bridge requires Kodex-shaped params such as `{ server, tool }` for `tools/call` and `{ message, metadata }` for `ui/message`; spec apps send `{ name, arguments }` and `{ role, content }`.
- `bridge_initialize` defaults to the older `2025-11-21` version when `protocolVersion` is absent and includes Kodex-specific result fields beside MCP Apps fields.
- `ui/open-link` is advertised only when granted, but the implementation still returns a non-spec `{ opened: false }` result instead of opening or returning a policy error.
- `apps/gateway/src/routes/generated_ui.rs`, generated UI DTOs in `apps/gateway/src/api.rs`, and generated UI compatibility tests still exist.
- `apps/gateway/src/mcp.rs` exposes both generated app-surface tools and older generated UI tools. The older descriptions still instruct `window.kodex.submitMessage(...)` and `kodex.generatedUi.submit`.

Frontend:

- `apps/web/src/appSurfaces/AppSurfacePane.tsx` fetches an app-surface document, wraps it with `apps/web/src/generatedUi/themeDocument.ts`, and renders direct `srcDoc` in a single `sandbox="allow-scripts"` iframe.
- The web host accepts JSON-RPC requests but also accepts legacy `kodex.generatedUi.submit`, `kodex:generated-ui:submit`, and `kodex.ui.submit` messages.
- Tool input/result notifications are posted after `ui/initialize` success or after `ui/notifications/initialized`; the spec path should wait for initialized and preserve the required input-before-result order.
- Workspace pane names and several frontend APIs still use `generatedUi` as the pane kind even when rendering app surfaces.
- `apps/web/src/api/client.ts`, `apps/web/src/api/generated/schema.ts`, and live event routing still include generated UI public contracts.

Plugin/docs:

- `plugins/kodex-control/skills/generative-ui/SKILL.md` describes app surfaces but still shows the old Kodex submit helper and legacy submit event names.
- `plugins/kodex-control/README.md` needs to describe generated app surfaces as MCP Apps protocol surfaces, not a separate submit-only runtime.

## Settled Decisions

- Hard cut generated app surfaces to the MCP Apps protocol.
- Do not keep Kodex legacy aliases for MCP provider or generated provider sessions.
- Discard existing generated HTML instead of migrating stored legacy documents.
- Generated app surfaces are host-originated MCP Apps with synthetic `ui://kodex-generated/...` resources.
- External MCP Apps keep same-server tool scope. Generated surfaces get an app-local granted tool registry where each exposed app tool has a bridge-visible `name` that resolves to a stored MCP server/tool or host action.
- Use static validation for generated app-surface requests to reject old submit protocols and obvious non-MCP Apps bridge code. Do not try to fully parse arbitrary JavaScript.
- A host may inject a convenience helper only if it sends spec JSON-RPC, for example `ui/message` with `{ role, content }`.
- The web runtime must move to a different-origin sandbox proxy before claiming web-host compliance.

## Milestones

### 1. Lock The Spec Contract With Failing Tests

Scope: `apps/gateway/src/app_surfaces.rs`, `apps/gateway/src/routes/app_surfaces.rs`, `apps/gateway/src/routes/mod.rs`, `apps/web/src/appSurfaces/`, `apps/web/src/appSurfaces/AppSurfacePane.test.tsx`, and new focused fixture modules as needed.

Work:

- Add MCP Apps fixture builders for:
  - `_meta.ui.resourceUri` on tools,
  - tool visibility `["model", "app"]`, `["app"]`, and `["model"]`,
  - resource `text` and base64 `blob`,
  - full `_meta.ui.csp` fields,
  - `_meta.ui.permissions`,
  - `CallToolResult` with `content`, `structuredContent`, `_meta`, and `isError`.
- Add failing backend bridge tests for standard JSON-RPC params:
  - `tools/call` with `{ name, arguments }`,
  - `resources/read` with `{ uri }`,
  - `ui/message` with `{ role: "user", content: { type: "text", text } }`,
  - `ping`,
  - `notifications/message`,
  - `ui/request-display-mode`,
  - denied `ui/open-link` returning a JSON-RPC error.
- Add failing frontend tests proving the iframe-visible protocol contains no Kodex legacy submit event handling.
- Add generated-provider validation tests that reject HTML containing `kodex.generatedUi.submit`, `kodex:generated-ui:submit`, `kodex.ui.submit`, or old submit-result event usage.

Exit criteria:

- Tests fail for the current non-spec bridge shapes before implementation.
- Fixtures are reusable by backend and frontend app-surface tests.
- The plan for generated static validation is encoded in tests, not only tool descriptions.

### 2. Complete Resource Metadata, CSP, And Permissions

Scope: `apps/gateway/src/store.rs`, `apps/gateway/src/store/app_surfaces.rs`, `apps/gateway/src/store/migrations.rs`, `apps/gateway/src/app_surfaces.rs`, `apps/gateway/src/routes/app_surfaces.rs`, `apps/web/src/generatedUi/themeDocument.ts` or its app-surface replacement.

Work:

- Extend `AppSurfaceCsp` to include `baseUriDomains` and `frameDomains` in addition to `connectDomains` and `resourceDomains`.
- Add an `AppSurfacePermissions` DTO for camera, microphone, geolocation, and clipboard-write.
- Preserve resource `_meta.ui.raw` metadata for future fields while explicitly projecting known fields.
- Support resource content from either `text` or base64 `blob`; reject missing/invalid content with fallback behavior.
- Enforce `ui://` resource URI and exact `text/html;profile=mcp-app` MIME type for renderable sessions.
- Update `app_surface_csp` and frontend CSP injection to:
  - deny by default,
  - include declared connect/resource/frame/base domains,
  - block `object-src`,
  - avoid silently dropping declared frame/base domains.
- Return accurate `hostCapabilities.sandbox.permissions` and `hostCapabilities.sandbox.csp` from `ui/initialize`.

Exit criteria:

- Backend parser tests cover every stable resource metadata field.
- Document route tests assert CSP directives for connect, resource, frame, base, object, and defaults.
- Frontend tests show declared frame/base domains are present when srcdoc/meta CSP is still used.
- Generated OpenAPI DTOs include the expanded CSP and permissions shapes after regeneration in a later milestone.

### 3. Make The Gateway Bridge Spec-First

Scope: `apps/gateway/src/routes/app_surfaces.rs`, `apps/gateway/src/app_surfaces.rs`, `apps/gateway/src/app_server_api/client.rs`, `apps/gateway/src/routes/approvals.rs`, `apps/gateway/src/events.rs`.

Work:

- Keep the HTTP bridge envelope token/revision check between web host and gateway, but make iframe-visible params standard MCP Apps JSON-RPC.
- Change `tools/call` handling:
  - MCP provider: resolve `params.name` against the originating MCP server from session provenance.
  - Generated provider: resolve `params.name` against stored app-local grants, where each grant maps a bridge-visible name to a server/tool or host action.
  - Reject model-only tools, ungranted names, cross-server MCP-provider calls, and stale revisions with JSON-RPC errors.
- Change `resources/read` handling:
  - resolve `{ uri }` on the app's originating MCP server for MCP provider,
  - resolve generated `ui://kodex-generated/...` resources from stored rows for generated provider,
  - reject ungranted external resources.
- Change `ui/message` handling to accept `{ role, content }`; route only explicit user text messages into the thread input path.
- Keep `ui/update-model-context` gateway-owned and compact: store or emit the latest context update without treating browser state as durable truth.
- Implement `ping`, `notifications/message`, `ui/request-display-mode`, and spec-shaped `ui/open-link` denial/error behavior.
- Update `ui/initialize`:
  - default to `2026-01-26`,
  - validate app capabilities enough to reject malformed input,
  - return `hostInfo`, `hostCapabilities`, and `hostContext` in spec shape,
  - advertise only genuinely supported capabilities.
- Keep bridge audit events compact and avoid persisting large HTML or large tool results.

Exit criteria:

- Backend route tests pass for allowed and rejected spec-shaped bridge calls.
- Same-server external MCP scope and generated app-local grant scope are both enforced.
- Bridge responses are JSON-RPC-compatible result/error objects from the iframe's perspective.
- Existing approval tests still pass, with generated-provider tool calls requiring approval where current policy requires it.

### 4. Hard Cut Generated Surfaces To Host-Originated MCP Apps

Scope: `apps/gateway/src/routes/self_control.rs`, `apps/gateway/src/routes/generated_ui.rs`, `apps/gateway/src/store/generated_ui.rs`, `apps/gateway/src/api.rs`, `apps/gateway/src/mcp.rs`, `plugins/kodex-control/skills/generative-ui/SKILL.md`, `plugins/kodex-control/README.md`.

Work:

- Remove generated UI as a public route/storage contract:
  - remove or retire `/v1/threads/{threadId}/generated-ui`,
  - remove `/v1/generated-ui/sessions/{sessionId}/document`,
  - remove `/v1/generated-ui/sessions/{sessionId}/submit`,
  - remove generated UI DTOs from OpenAPI.
- Keep generated app surfaces only through app-surface endpoints:
  - `POST /v1/self-control/threads/{threadId}/app-surface`,
  - `GET /v1/self-control/threads/{threadId}/app-surface`,
  - `DELETE /v1/self-control/threads/{threadId}/app-surface`,
  - `POST /v1/self-control/threads/{threadId}/app-surface/presentation`.
- Generate synthetic resource URIs like `ui://kodex-generated/sessions/{sessionId}/revisions/{revision}` and return them through `resources/read`.
- Extend generated tool grants to include a required bridge-visible `name`; keep `server` and `tool` as the gateway resolution target.
- Replace `open_generated_ui`, `update_generated_ui`, `get_generated_ui`, and `archive_generated_ui` MCP tools with app-surface tools only. If old names remain temporarily in code during a single branch, they must not be installed or documented as callable tools at completion.
- Update Kodex Control tool descriptions to instruct models to:
  - provide `fallbackContent`,
  - use MCP Apps JSON-RPC methods,
  - call `ui/message` for conversational user actions,
  - call `tools/call` by granted bridge-visible tool name,
  - avoid all old Kodex submit event names.
- Add static generated HTML validation in `validate_app_surface_html` or a sibling helper for generated provider submissions:
  - reject old Kodex submit event names,
  - reject old submit-result event listeners,
  - optionally warn on direct `postMessage` payloads without `jsonrpc: "2.0"`,
  - allow a new injected helper only if it emits spec JSON-RPC.
- Update plugin docs and run the plugin cachebuster update when implementation lands.

Exit criteria:

- OpenAPI no longer exposes generated UI public routes or generated UI DTOs.
- MCP stdio tests cover `open_app_surface`/`update_app_surface` generated-provider creation and reject old generated UI submit HTML.
- Plugin skill docs contain no `kodex.generatedUi.submit`, `kodex:generated-ui:submit`, `kodex.ui.submit`, or old submit-result protocol references.
- Existing generated HTML is intentionally ignored or discarded; no migration is required for old generated UI rows.

### 5. Replace The Web Runtime With A Spec Sandbox Proxy

Scope: `apps/web/src/appSurfaces/`, `apps/web/src/generatedUi/themeDocument.ts`, `apps/web/src/panes/generatedUi/GeneratedUiWorkspacePane.tsx`, `apps/web/src/workspace/`, `apps/web/src/styles/`, gateway static routes if the proxy is served by the gateway.

Work:

- Replace the direct single `srcDoc` app iframe with a web-host sandbox proxy:
  - outer host loads a sandbox proxy iframe from a different origin,
  - sandbox proxy uses `allow-scripts allow-same-origin`,
  - proxy sends `ui/notifications/sandbox-proxy-ready`,
  - host sends `ui/notifications/sandbox-resource-ready` with HTML, CSP, and permissions,
  - proxy loads the app HTML in an inner iframe and forwards non-sandbox messages.
- Provide loopback defaults for development:
  - if host is `localhost`, try `127.0.0.1` as the sandbox origin,
  - if host is `127.0.0.1`, try `localhost`,
  - allow explicit `KODEX_APP_SURFACE_SANDBOX_ORIGIN` or frontend config for VPN/non-loopback access.
- If no different sandbox origin is available, fail closed or clearly degrade without advertising full web-host compliance.
- Move theme injection to MCP Apps host context:
  - provide standardized CSS variable names in `hostContext.styles.variables`,
  - keep Kodex variables only as optional extras,
  - stop mutating app HTML as the primary bridge/theming mechanism where possible.
- Implement iframe-side message correlation in a dedicated `apps/web/src/appSurfaces/appBridge.ts`.
- Enforce lifecycle ordering:
  - respond to `ui/initialize`,
  - wait for `ui/notifications/initialized`,
  - then send `ui/notifications/tool-input`,
  - then send `ui/notifications/tool-result` or `ui/notifications/tool-cancelled`.
- Implement `ui/notifications/size-changed`, `ui/request-display-mode`, and `ui/resource-teardown` enough for common SDK apps.
- Remove legacy generated UI message parsing from `AppSurfacePane`.

Exit criteria:

- Component tests cover sandbox-proxy readiness, resource-ready delivery, message forwarding, lifecycle ordering, size change, teardown, stale revision rejection, and error propagation.
- No frontend app-surface code accepts old Kodex submit event names.
- Browser-visible behavior is validated with `$agent-browser` on desktop fine pointer, narrow fine pointer, and narrow touch/mobile shapes.
- Console output has no uncontrolled CSP, sandbox, or bridge errors for fixture apps.

### 6. Rename And Simplify Frontend Ownership

Scope: `apps/web/src/workspace/`, `apps/web/src/panes/generatedUi/`, `apps/web/src/api/client.ts`, `apps/web/src/events/liveRouting.ts`, `apps/web/src/events/useLiveEventHandlers.ts`, `apps/web/src/api/queryKeys.ts`, tests under the same directories.

Work:

- Rename pane kind and workspace APIs from `generatedUi` to `appSurface` where they now represent the unified runtime.
- Remove generated UI cache keys and generated UI event routing.
- Keep local pane hide/focus state browser-local, but keep app-surface session status and bridge outcomes gateway-owned.
- Keep presentation events `app_surface.presentation_requested` as the source for opening/focusing panes.
- Update app-surface cache handling to refetch or converge through gateway-owned events for same-user two-tab behavior.

Exit criteria:

- Frontend tests no longer import generated UI DTOs or route generated UI events.
- Workspace tests cover app-surface pane presentation for `open` and `focus`.
- Same-user two-tab test shape verifies app-surface submitted/error state converges through gateway SSE/cache, while local hide remains per-tab.

### 7. Regenerate API, Update Docs, And Trim Stale Code

Scope: `apps/gateway/src/api.rs`, `apps/web/src/api/generated/schema.ts`, `README.md`, `plugins/kodex-control/README.md`, `plugins/kodex-control/.codex-plugin/plugin.json`, `AGENTS.md` only if workflow guidance changes, `plans/index.md`.

Work:

- Regenerate OpenAPI and frontend types after backend route/DTO changes.
- Remove stale generated UI tests, DTO exports, route registrations, and frontend client wrappers.
- Update README to describe:
  - MCP Apps host support,
  - generated app surfaces as host-originated MCP Apps,
  - sandbox proxy requirements,
  - CSP and permissions behavior,
  - tool/resource grants,
  - local/VPN-only deployment assumption.
- Update Kodex Control plugin docs and skill docs.
- Update plugin cachebuster when `plugins/kodex-control` changes.
- Run trim scripts before completion and remove unused generated UI code surfaced by them.

Exit criteria:

- `/openapi.json` and `apps/web/src/api/generated/schema.ts` contain app-surface routes only for this runtime.
- `README.md` and plugin docs do not contradict the unified MCP Apps protocol.
- `./tools/trim-backend.sh` and `./tools/trim-frontend.sh` have been run or documented with any unrelated pre-existing findings.
- `plans/index.md` reflects the current active status and scope.

### 8. End-To-End Compatibility Validation

Scope: local gateway/web dev environment, app-surface fixtures, real MCP Apps servers, `$agent-browser`.

Work:

- Validate a simple official MCP Apps example before richer apps:
  - install through normal MCP server config,
  - confirm app-server status exposes `_meta.ui.resourceUri`,
  - trigger a model/tool call that creates an app-surface session,
  - render the app through the sandbox proxy,
  - call an app-visible same-server tool with standard `tools/call`.
- Validate a generated app surface:
  - local-only interactions,
  - `ui/message`,
  - granted `tools/call`,
  - `resources/read`,
  - rejected or approval-required tool call.
- Validate a richer MCP app such as Excalidraw or Budget Allocator after the simple fixture passes.
- Capture console errors, CSP violations, blank iframe checks, bridge traces, responsive layout, and text overlap issues.

Exit criteria:

- At least one spec-compliant external MCP App renders and completes a bridge tool call without custom shims.
- At least one generated app surface renders and uses the same protocol for message/tool/resource interactions.
- Desktop split, narrow desktop, and narrow touch/mobile app-surface panes are usable and nonblank.
- The app-surface runtime has no legacy generated UI submit protocol acceptance.

## Verification Matrix

- Backend parser: resource URI, full resource metadata, text/blob content, visibility defaults, generated HTML static validation.
- Backend bridge: JSON-RPC shapes, same-server MCP scope, generated app-local grants, approval-required paths, compact audit events.
- Backend API: generated UI public routes removed, app-surface DTOs in OpenAPI, app-server schema assumptions preserved.
- Frontend runtime: sandbox proxy, lifecycle ordering, request/response correlation, size change, teardown, stale iframe rejection.
- Frontend workspace: app-surface pane naming, presentation events, local hide behavior, same-user two-tab convergence.
- Plugin/docs: app-surface tool schemas/descriptions, generative UI skill, plugin README, cachebuster.
- Browser: `$agent-browser` desktop fine pointer, narrow fine pointer, narrow touch/mobile, console cleanliness, nonblank iframe content.

## Risks And Open Questions

- Different-origin sandbox provisioning is the highest operational risk. Loopback defaults can cover local development, but VPN/non-loopback access needs explicit `KODEX_APP_SURFACE_SANDBOX_ORIGIN` or equivalent configuration before full compliance can be claimed.
- Generated provider tool names need careful schema design. The plan requires bridge-visible app-local names so generated HTML can call standard `tools/call { name }` without a non-spec `{ server, tool }` payload.
- Some ecosystem apps may depend on draft or host-specific behavior beyond the stable 2026-01-26 spec. Start with stable fixtures and record any host-specific follow-up separately.
- Static HTML validation can catch old Kodex submit protocols and obvious non-JSON-RPC postMessage payloads, but it cannot prove arbitrary JavaScript is MCP Apps-compliant. Runtime bridge tests remain mandatory.
- Removing generated UI routes is a hard cut. Any old workspace pane state or stored generated HTML that references generated UI endpoints should fail cleanly and allow a new generated app surface to replace it.
