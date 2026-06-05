# MCP App Surfaces Plan

## Status

Active. Core app-surface storage, MCP resource detection, generated-provider self-control routes, Kodex Control tools, OpenAPI types, web pane rendering, MCP-style bridge notifications, token-bound bridge calls, generated-provider approval gating, compact audit events, and README/plugin guidance are implemented and covered by focused plus full test gates. A disposable gateway validated the official `@modelcontextprotocol/server-budget-allocator` MCP Apps example through normal app-server MCP install/status/resource-read paths and an approved app-surface bridge `tools/call`. Live `$agent-browser` validation with an authenticated model turn also created and rendered the official Budget Allocator MCP app pane; that pass exposed real compatibility fixes for bundled app HTML size and `ui/initialize` bridge handshakes, now covered by focused regression tests. Remaining work is later cleanup of legacy generated-UI compatibility aliases once that migration window closes.

## Goal

Add first-class MCP Apps host support to Kodex and migrate Kodex generated UI onto the same app-surface runtime. After this work, installed MCP servers that expose spec-compliant UI resources, such as Excalidraw-style MCP Apps, should render in the Kodex thread UI, and model-authored generated UI should use the same iframe bridge, host context, resource, tool-call, and capability model.

The intended product split is provider provenance, not capability:

- MCP Apps are external-server-authored app surfaces backed by MCP `ui://` resources and same-server app-visible tools.
- Generated UI is model-authored app surface content backed by Kodex-generated `ui://`-like resources and explicit session grants.
- Both render through one host runtime and communicate through one MCP Apps-compatible bridge.

## Spec Grounding

MCP Apps 2026-01-26 establishes these constraints:

- Hosts advertise support with the `io.modelcontextprotocol/ui` extension and `text/html;profile=mcp-app` MIME type during MCP initialize.
- Tools attach UI through `_meta.ui.resourceUri`, not by embedding HTML directly in tool results.
- Hosts fetch the referenced `ui://...` resource, render it in a sandboxed iframe, and deliver tool input and result data to the view with `ui/notifications/tool-input` and `ui/notifications/tool-result`.
- Views communicate with the host over JSON-RPC through `postMessage`, including app-side `tools/call`, `resources/read`, `ui/message`, and `ui/update-model-context`.
- Tool visibility is controlled by `_meta.ui.visibility`; default `["model", "app"]` allows both model and app access, `["app"]` hides a tool from the model but leaves it callable by apps, and app scope is per MCP server.
- `content` remains the text fallback for model/text-only hosts, while `structuredContent` is optimized for UI rendering.
- Servers should provide meaningful fallback content even when UI is available.

References:

- MCP Apps overview: `https://modelcontextprotocol.io/extensions/apps/overview`
- MCP Apps specification: `https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx`

## Current State

Backend:

- Generated UI is implemented as a special-purpose feature in `apps/gateway/src/routes/generated_ui.rs`, `apps/gateway/src/store/generated_ui.rs`, `apps/gateway/src/store.rs`, and `apps/gateway/src/store/migrations.rs`.
- The current table `generated_ui_sessions` stores `html` inline, one latest session per thread, a revision, a submit status, and submitted message metadata.
- `GET /v1/generated-ui/sessions/{sessionId}/document` serves the stored HTML with a self-contained CSP and `connect-src 'none'`.
- `POST /v1/generated-ui/sessions/{sessionId}/submit` validates a submit message, claims the session revision, routes the visible text through `submit_thread_input`, and emits `generated_ui.session_submitted`.
- Self-control generated UI endpoints in `apps/gateway/src/routes/self_control.rs` accept only `{ title, html, source, maxSelfControlDepth }`.
- Kodex Control MCP tools in `apps/gateway/src/mcp.rs` expose `open_generated_ui`, `update_generated_ui`, `get_generated_ui`, and `archive_generated_ui`, all aimed at the submit-only generated UI contract.
- MCP inventory/resource management exists in `apps/gateway/src/routes/mcp.rs` and `apps/gateway/src/app_server_api/client.rs`. It exposes `mcpServerStatus/list`, `mcpServer/resource/read`, OAuth login, reload, and config mutation.
- The app-server schema at `apps/gateway/app-server-schema/0.135.0/json/v2/McpServerToolCallParams.json` includes `mcpServer/tool/call`, but Kodex does not yet wrap it in `CodexClient` or expose it through a gateway bridge.
- `apps/gateway/src/app_server.rs::initialize_params` currently advertises only `experimentalApi`; it does not advertise the MCP Apps extension upstream to app-server-managed MCP server connections.

Frontend:

- `apps/web/src/generatedUi/GeneratedUiPane.tsx` fetches the generated UI document, wraps it with `buildGeneratedUiSrcDoc`, renders it with `sandbox="allow-scripts"` and `srcDoc`, and accepts only submit-shaped `postMessage` messages.
- `apps/web/src/generatedUi/themeDocument.ts` injects Kodex-specific CSS variables and a CSP meta tag into generated HTML.
- `apps/web/src/shell/KodexShellView.tsx` owns the desktop split-pane and narrow full-screen sheet layout for the generated UI pane.
- `apps/web/src/App.tsx` fetches the selected thread's latest generated UI, keeps local hide state by `sessionId:revision`, and optimistically renders submitted visible messages.
- `apps/web/src/events/liveRouting.ts`, `apps/web/src/events/stream.ts`, and `apps/web/src/generatedUi/cache.ts` route `generated_ui.*` events to frontend cache updates.
- MCP manager UI under `apps/web/src/mcp/` can inspect servers/resources but does not render MCP Apps or proxy iframe tool calls.

Plugin/docs:

- `plugins/kodex-control/skills/generative-ui/SKILL.md` instructs agents to create self-contained HTML and submit visible messages for conversational actions.
- `plugins/kodex-control/README.md` documents v1 generated UI as self-contained HTML with blocked external network access.
- `plans/generated-ui-pane.md` is complete and documents the old v1 non-goals: no direct iframe gateway API access, no external network, no MCP tool calls, and a tiny submit-only host protocol.

## Product Decisions

- Hard-cut the existing generated UI schema and API shape if needed. Do not preserve `generated_ui_sessions` as the long-term storage contract.
- Build one app-surface runtime, not parallel "MCP Apps UI" and "generated UI" iframe systems.
- Match capabilities between MCP Apps and generated UI as much as possible. The difference is who authored the UI and how grants are derived.
- Generated UI may call tools/resources through the same bridge as MCP Apps, subject to stored session grants and gateway approval policy.
- MCP Apps preserve spec same-server app scope. Generated UI has no natural same-server boundary, so its boundary is explicit session grants.
- Browser-local hide/reopen behavior can remain local UI state. Shared lifecycle, resources, grants, submissions, and app-session status must be gateway-owned.
- External network remains denied by default for generated app surfaces, but the new model should represent CSP/network as structured metadata so approved resource/connect domains can be added later without another schema rewrite.

## Target Architecture

### App Surface Domain

Replace generated-UI-specific storage and API concepts with a provider-neutral app surface:

```text
AppSurfaceSession
  id
  threadId
  provider: "mcp" | "generated"
  title
  status: "active" | "submitting" | "submitted" | "archived" | "errored"
  revision
  resourceUri
  resourceMimeType: "text/html;profile=mcp-app"
  fallbackContent
  displayModes
  csp
  permissions
  provenance
  grants
  createdAt / updatedAt / archivedAt
```

Provider-specific provenance:

- MCP app surface: MCP server name, tool name, tool call id/item id/turn id when available, original `resourceUri`, tool input, tool result summary.
- Generated app surface: creating thread/turn/tool-call provenance, model-authored resource URI such as `ui://kodex-generated/sessions/{sessionId}/revisions/{revision}`, source tool call id, source/self-control metadata.

Grant model:

- MCP provider grants are derived from same-server MCP tool/resource metadata and `_meta.ui.visibility`.
- Generated provider grants are declared by `open_generated_ui`/`update_generated_ui` input and stored on the session after gateway policy validation.
- All bridge calls must check session id, revision, provider, grant, thread id, and status before hitting app-server or gateway APIs.

### Backend Modules

Add a new app-surface domain instead of extending generated UI names:

- `apps/gateway/src/routes/app_surfaces.rs`
- `apps/gateway/src/store/app_surfaces.rs`
- `apps/gateway/src/app_surfaces.rs` for metadata parsing, CSP construction, grant validation, and bridge request helpers
- `apps/gateway/src/routes/self_control.rs` migrated to app-surface upsert/read/archive endpoints for generated surfaces
- `apps/gateway/src/routes/mcp.rs` extended with guarded tool-call/resource bridge routes only where needed by app surfaces
- `apps/gateway/src/app_server_api/client.rs` extended with `mcp_tool_call`

The legacy generated UI route/module names can be removed or kept only as short-lived aliases during one implementation chunk. The final public API should use app-surface names.

Suggested routes:

- `GET /v1/threads/{threadId}/app-surface`
- `GET /v1/app-surfaces/{sessionId}/document?revision=...`
- `POST /v1/app-surfaces/{sessionId}/bridge`
- `DELETE /v1/self-control/threads/{threadId}/app-surface`
- `GET /v1/self-control/threads/{threadId}/app-surface`
- `POST /v1/self-control/threads/{threadId}/app-surface/generated`

Keep "latest visible app surface per thread" as the initial UX rule unless implementation of MCP tool-result sessions requires a separate historical association. If multiple app surfaces per thread become necessary, store many sessions but project one active session in `GET /v1/threads/{threadId}/app-surface`.

### Frontend Modules

Create a provider-neutral frontend domain:

- `apps/web/src/appSurfaces/AppSurfacePane.tsx`
- `apps/web/src/appSurfaces/appBridge.ts`
- `apps/web/src/appSurfaces/theme.ts`
- `apps/web/src/appSurfaces/cache.ts`
- `apps/web/src/styles/app-surfaces.css`

Replace imports from `generatedUi` in `App.tsx`, `events/liveRouting.ts`, `events/stream.ts`, `api/client.ts`, and `shell/KodexShellView.tsx` with app-surface equivalents.

The runtime should:

- fetch a document resource by session/revision,
- render it in a sandboxed iframe,
- inject/provide host context and theme using MCP Apps-compatible names where practical,
- establish a JSON-RPC bridge with request/response ids,
- send initialization, tool input, and tool result notifications,
- proxy allowed `tools/call`, `resources/read`, `ui/message`, `ui/update-model-context`, `ui/open-link`, and display-mode requests through the gateway,
- keep existing desktop split and mobile sheet UX, renamed from generated UI to app surface in code and labels where user-visible copy allows.

## Milestones

### 1. Spec Fixtures And App-Surface Data Model

Scope: `apps/gateway/src/store/migrations.rs`, `apps/gateway/src/store.rs`, new `apps/gateway/src/store/app_surfaces.rs`, new `apps/gateway/src/app_surfaces.rs`, tests in `apps/gateway/src/routes/mod.rs` or a new focused test module.

Work:

- Start with failing backend tests for app-surface session creation, latest-per-thread selection, revision replacement, archive, and grant persistence.
- Add MCP Apps fixture payloads covering:
  - tool `_meta.ui.resourceUri`,
  - resource `mimeType: "text/html;profile=mcp-app"`,
  - resource `_meta.ui.csp`,
  - tool `_meta.ui.visibility` values `["model", "app"]`, `["app"]`, and `["model"]`,
  - tool result `content`, `structuredContent`, and `_meta`.
- Replace or supersede the `generated_ui_sessions` data shape with app-surface tables. Suggested tables:
  - `app_surface_sessions`
  - `app_surface_resources` for generated HTML and fetched/cached MCP HTML metadata where caching is needed
  - `app_surface_grants`
  - `app_surface_submissions` or submission columns if one-submit-per-revision remains enough
- Define Rust DTOs with `utoipa::ToSchema` for `AppSurfaceSessionDto`, provider/provenance structs, CSP/permission structs, grant structs, bridge request/response envelopes, and document query.
- Add parsers for MCP Apps `_meta.ui` metadata and visibility with tests that preserve unknown metadata for future compatibility.
- Keep migration posture explicit: no need to preserve old local generated UI sessions; archived/local stale rows may be ignored or dropped by migration.

Exit criteria:

- Focused store/parser tests pass.
- The old generated UI table is no longer the authoritative app-surface model.
- DTO names and route schemas are app-surface/generic, not generated-UI-specific.

### 2. App-Server MCP Apps Capability And MCP Tool Proxy

Scope: `apps/gateway/src/app_server.rs`, `apps/gateway/src/app_server_api/client.rs`, `apps/gateway/src/app_server_api/mod.rs`, `apps/gateway/src/routes/mcp.rs`, checked-in app-server schema references under `apps/gateway/app-server-schema/0.135.0/json`.

Work:

- Update app-server initialize params to advertise MCP Apps support if the upstream app-server uses client capabilities when initializing MCP servers:

```json
{
  "capabilities": {
    "experimentalApi": true,
    "extensions": {
      "io.modelcontextprotocol/ui": {
        "mimeTypes": ["text/html;profile=mcp-app"]
      }
    }
  }
}
```

- Verify against `apps/gateway/app-server-schema/0.135.0/json` and the upstream app-server README before changing initialize shape.
- Add typed `McpServerToolCallParams` and `McpServerToolCallResponse` wrappers matching the checked-in schema.
- Add `CodexClient::mcp_tool_call(server, thread_id, tool, arguments, meta)`.
- Keep raw MCP tool-call access behind app-surface bridge policy; do not add a broad UI button in Preferences that calls arbitrary tools.
- Extend route tests to prove tool-call requests validate against schema and preserve `content`, `structuredContent`, `_meta`, and `isError`.

Exit criteria:

- App-server initialization still passes compatibility probes.
- Gateway tests cover `mcpServer/tool/call` success/error payload shapes.
- `mcpServer/resource/read` remains compatible with existing Preferences > MCP resource viewing.

### 3. MCP App Provider Session Creation

Scope: `apps/gateway/src/thread_view.rs`, `apps/gateway/src/app_server_api/timeline.rs`, `apps/gateway/src/thread_view_projection.rs`, new `apps/gateway/src/app_surfaces.rs`, route tests with app-server fixtures.

Work:

- Detect MCP tool calls or results in canonical thread view snapshots/patches whose raw payload or normalized MCP item payload includes `_meta.ui.resourceUri`.
- Use the tool call context to create or update an app-surface session:
  - thread id,
  - turn id/item id/tool call id,
  - server name and tool name,
  - resource URI,
  - tool input arguments,
  - tool result content/structuredContent/_meta,
  - fallback content from tool result `content`.
- Read the UI resource through `mcpServer/resource/read` when creating or rendering the session. Enforce `text/html;profile=mcp-app` for app rendering and degrade to fallback content for unsupported/missing MIME.
- Build grants from the same MCP server's tool inventory:
  - app can call tools with `_meta.ui.visibility` containing `"app"` or missing visibility,
  - model-only tools are rejected from bridge calls,
  - app scope is limited to that MCP server for MCP-provider sessions.
- Emit app-surface events such as:
  - `app_surface.session_upserted`
  - `app_surface.session_submitted`
  - `app_surface.session_archived`
  - `app_surface.session_error`
- Make selected-thread and global SSE clients converge by refetching `GET /v1/threads/{threadId}/app-surface`.

Exit criteria:

- Backend tests show a mocked MCP tool result with `_meta.ui.resourceUri` creates an app-surface session.
- Tool input/result data are available to the bridge for `ui/notifications/tool-input` and `ui/notifications/tool-result`.
- App-only same-server tool grants work; model-only and cross-server calls are rejected.
- Text fallback remains available when resource read or MIME validation fails.

### 4. Generated App Provider And Kodex Control Migration

Scope: `apps/gateway/src/routes/self_control.rs`, `apps/gateway/src/mcp.rs`, `plugins/kodex-control/skills/generative-ui/SKILL.md`, `plugins/kodex-control/README.md`, plugin manifest cachebuster when implementation lands.

Work:

- Replace generated UI self-control request shape with an app-surface generated-provider request:

```json
{
  "title": "Review dashboard",
  "html": "<!doctype html>...",
  "fallbackContent": "Interactive review dashboard.",
  "displayModes": ["inline", "fullscreen"],
  "csp": {
    "connectDomains": [],
    "resourceDomains": []
  },
  "grants": {
    "tools": [
      { "server": "kodex-control", "tool": "send_thread_input" }
    ],
    "resources": [],
    "canSendMessage": true,
    "canUpdateModelContext": true,
    "canOpenLinks": false
  },
  "source": {}
}
```

- Store generated HTML as a generated `ui://kodex-generated/...` resource with MCP App MIME semantics.
- Validate generated-provider grants through gateway policy:
  - built-in safe host actions can be allowed by default,
  - MCP tools/resources require explicit grants,
  - write/destructive/networked grants require approval or a conservative allowlist,
  - all grant decisions are persisted on the session and audited.
- Update Kodex Control MCP tools:
  - keep familiar `open_generated_ui` and `update_generated_ui` names if useful for model ergonomics,
  - change their schemas to emit app-surface metadata/grants,
  - return app-surface session metadata, not generated-UI-specific DTOs.
- Rewrite the generative UI skill to teach MCP Apps bridge capabilities, grant discipline, fallback content, app-message behavior, and same runtime expectations.
- Keep backwards-compatible submit message support only as a temporary implementation detail if needed; the final guidance should use JSON-RPC bridge methods.

Exit criteria:

- MCP stdio tests in `apps/gateway/tests/kodex_control_mcp_stdio.rs` cover generated app-surface creation with grants.
- Self-control tests cover grant validation, audit events, fallback content, and generated resource rendering.
- Plugin docs no longer describe generated UI as submit-only or no-tool-call-capable.

### 5. App Bridge Runtime In The Web Client

Scope: `apps/web/src/appSurfaces/`, `apps/web/src/shell/KodexShellView.tsx`, `apps/web/src/App.tsx`, `apps/web/src/events/liveRouting.ts`, `apps/web/src/events/stream.ts`, `apps/web/src/api/client.ts`, `apps/web/src/styles/app-surfaces.css`.

Work:

- Extract the current generated UI pane layout into `AppSurfacePane`.
- Replace `srcDoc`-only rendering with a route-backed document load where possible so response headers/CSP are authoritative. If `srcDoc` is retained for theme injection, the plan must include tests documenting why host headers cannot be used and how CSP remains enforced.
- Implement MCP Apps-compatible JSON-RPC over `postMessage`:
  - `ui/initialize`,
  - initialized notification,
  - `ui/notifications/tool-input`,
  - `ui/notifications/tool-result`,
  - `tools/call`,
  - `resources/read`,
  - `ui/message`,
  - `ui/update-model-context`,
  - `ui/open-link`,
  - teardown,
  - display mode requests where supported.
- Provide host context with theme, locale, timezone, display mode, dimensions, platform, and standardized CSS variables. Continue mapping Kodex theme tokens, but expose MCP Apps variable names where practical.
- Route bridge requests to `POST /v1/app-surfaces/{sessionId}/bridge`, not directly to MCP or thread APIs.
- Preserve existing desktop split-pane resizing and narrow/mobile full-height sheet behavior, renaming CSS/classes from generated UI to app surfaces as part of the hard cut.
- Keep local hide state scoped by `sessionId:revision`; new app-surface revisions reopen.
- Add host chrome that distinguishes provider/provenance subtly without making the UI feel like a debug tool.

Exit criteria:

- Component tests cover bridge initialization, tool input/result delivery, tool-call success/error responses, resource read, `ui/message`, rejected stale session/revision messages, hide/reopen, and submitted/error states.
- Frontend cache tests cover `app_surface.*` events and two-tab convergence by refetch.
- `cd apps/web && npm test` focused app-surface suites pass.
- `cd apps/web && npm run build` passes after generated OpenAPI types are refreshed.

### 6. Gateway Bridge Policy, Approvals, And Auditing

Scope: `apps/gateway/src/routes/app_surfaces.rs`, `apps/gateway/src/routes/approvals.rs`, `apps/gateway/src/store/events.rs`, `apps/gateway/src/events.rs`, approval tests, generated OpenAPI artifacts.

Work:

- Implement one bridge endpoint that accepts JSON-RPC-like request envelopes from the web client and returns JSON-RPC-like responses.
- Validate:
  - session exists and is active,
  - revision matches,
  - iframe origin/window token or equivalent frontend session token matches,
  - requested bridge method is supported,
  - requested tool/resource/message/link action is granted,
  - MCP provider same-server scope is preserved,
  - generated provider explicit grant scope is preserved.
- Route:
  - `tools/call` for MCP provider to `mcpServer/tool/call` on the same server,
  - `tools/call` for generated provider to granted MCP servers or Kodex self-control tools through policy,
  - `resources/read` to `mcpServer/resource/read` or generated resource storage,
  - `ui/message` to normal visible thread input when configured,
  - `ui/update-model-context` to stored session context or a visible/ephemeral event until there is a stronger model-context contract,
  - `ui/open-link` through an allowlisted host action with explicit rejection by default for untrusted domains.
- Integrate approval prompts for grant requests or bridge calls that are write-capable, destructive, networked, or otherwise high-risk. Reuse existing approval/event patterns rather than browser-owned decisions.
- Persist bridge audit events with session id, provider, thread id, method, tool/resource name, grant id, approval id when any, and result status. Avoid persisting large HTML or large tool results in events.

Exit criteria:

- Backend route tests cover allowed and rejected bridge methods, same-server MCP app scope, generated explicit grants, approval-required actions, and event/audit payloads.
- Same-user two-tab test shape proves one tab observes app-surface submitted/error state after another tab triggers a bridge action.
- Security tests prove ungranted cross-server tool calls and model-only tools are rejected.

### 7. API Regeneration, Docs, And Migration Cleanup

Scope: `apps/gateway/src/api.rs`, `apps/web/src/api/generated/schema.ts`, `README.md`, `plugins/kodex-control/README.md`, `plans/index.md`, `AGENTS.md` only if workflow rules change.

Work:

- Register all app-surface DTOs/routes in OpenAPI.
- Regenerate frontend OpenAPI types with a running gateway.
- Remove stale generated UI exports/routes/tests once app-surface replacements pass.
- Update README to describe:
  - MCP Apps host support,
  - generated UI as model-authored app surfaces,
  - local/VPN-only security assumption,
  - sandbox/CSP/tool-grant behavior,
  - expected MCP server install/use flow.
- Update Kodex Control docs and skill references from generated UI pane to generated app surfaces.
- Keep `plans/generated-ui-pane.md` as historical complete work; this plan supersedes its runtime contract without rewriting history.

Exit criteria:

- `/openapi.json` includes app-surface routes and no stale generated UI-only public contract unless intentionally aliased.
- `apps/web/src/api/generated/schema.ts` is current.
- README and plugin README no longer contradict the new bridge/tool-call capability.
- `plans/index.md` reflects this plan status.

### 8. End-To-End Validation With Real MCP Apps

Scope: local gateway/web dev environment, installed MCP Apps test servers, Playwright or `$agent-browser` validation.

Work:

- Use a simple official MCP Apps example first, such as a QR, transcript, or budget allocator server, to validate the protocol before Excalidraw.
- Validate Excalidraw or another rich app after the simple fixture passes.
- Validate generated app surfaces with:
  - local-only interactions,
  - `ui/message`,
  - same bridge `tools/call`,
  - resource reads,
  - approval-required/rejected grants.
- Use `$agent-browser` for desktop fine pointer, narrow fine pointer, and narrow touch/mobile shapes.
- Capture console errors, iframe blankness, CSP violations, bridge request/response traces, and visual overlap/text-fit issues.

Exit criteria:

- A spec-compliant MCP Apps server renders from a normal MCP install path and can call an app-visible same-server tool.
- A generated app surface renders through the same runtime and can use a granted tool.
- Desktop split and mobile sheet remain usable with both providers.
- Browser validation shows nonblank iframe content, working bridge calls, no uncontrolled cross-origin/network access, and no incoherent layout overlap.

## Verification Matrix

- Backend store: app-surface session/resource/grant persistence, revision replacement, archive, latest-by-thread projection.
- Backend MCP: capability advertisement, resource read, tool call, metadata parsing, visibility enforcement.
- Backend bridge: method validation, grant enforcement, same-server scope, approval policy, audit events.
- Frontend bridge: initialize, notifications, request/response correlation, stale iframe rejection, error propagation.
- Frontend UX: desktop split, mobile sheet, local hide, provider provenance, resize, submitted/error states.
- Multi-client: app-surface events and refetch converge across two tabs; hide remains local.
- Security: sandboxed iframe, CSP from session metadata, no ungranted tools/resources, no cross-server MCP app calls, generated provider grants audited.
- Docs/API: OpenAPI regenerated, frontend types generated, README/plugin docs aligned.

## Risks And Open Questions

- App-server capability propagation may not be sufficient for upstream MCP servers to expose UI metadata. If app-server strips or ignores MCP Apps extension capabilities, the implementation must either update app-server integration or document the blocker before frontend work proceeds.
- App-server raw MCP tool-call item shapes may not carry enough server/tool/resource metadata to create sessions from timeline alone. Resolve by inspecting real `mcpToolCall` raw payloads from a spec-compliant test server and, if necessary, adding an explicit gateway hook at the app-server MCP tool-call response boundary.
- MCP Apps has host-specific behavior in the ecosystem. Start with spec fixtures and a simple official example before testing Excalidraw, because Excalidraw may depend on host quirks or older MCP-UI conventions.
- `ui/update-model-context` needs a precise Kodex meaning. Initial implementation can store it as app-surface session context and surface it to the model only through explicit visible/user-mediated actions until a gateway-owned model-context contract exists.
- External network policy for generated app surfaces should remain deny-by-default. Any allowlist/approval expansion must be explicit in grants, CSP, and audit events.
- Large HTML/resources/tool results can bloat SQLite and SSE payloads. Store large content in resource rows, keep events compact, and enforce size limits before exposing real MCP Apps broadly.
- If multiple MCP App surfaces appear in one thread, "latest visible surface" may be too limiting. The first implementation can project one active surface, but storage should not make multiple sessions impossible.
