# Kodex Control Plugin Plan

Status: Complete.

## Context

Kodex should be able to install a first-party `kodex-control` plugin and, after explicit user action, expose guarded self-control capabilities to agents. The first use case is preview proxy evaluation and setup, but the long-term capability set also includes creating threads and managing automations.

This plan keeps the gateway as the source of truth. The plugin packages skills and exposes MCP capabilities, while all durable mutation semantics, reconciliation, provenance, audit events, and safety rules live in gateway-owned endpoints under `/v1/self-control/...`.

Relevant code seams:

- Plugin/app-server protocol exists in the checked-in app-server schema: `apps/gateway/app-server-schema/0.128.0/json/v2/PluginInstallParams.json`, `PluginListResponse.json`, `MarketplaceAddParams.json`, and related plugin/marketplace schemas.
- Gateway app-server calls live in `apps/gateway/src/app_server_api.rs` and are validated through `apps/gateway/src/schema.rs`.
- Gateway routes and OpenAPI registration live in `apps/gateway/src/routes/mod.rs` and `apps/gateway/src/api.rs`.
- Project preview CRUD and Caddy status live in `apps/gateway/src/routes/project_previews.rs` and `apps/gateway/src/previews.rs`.
- Thread creation/resume flows live in `apps/gateway/src/routes/threads.rs` and turn input flows in `apps/gateway/src/routes/turns.rs`.
- Automation CRUD/scheduler state lives in `apps/gateway/src/routes/automations.rs`, `apps/gateway/src/automations.rs`, and `apps/gateway/src/store.rs`.
- Preferences UI starts in `apps/web/src/PreferencesModal.tsx`; generated frontend API types live in `apps/web/src/api/generated/schema.ts`, wrappers in `apps/web/src/api/client.ts`, and query keys in `apps/web/src/api/queryKeys.ts`.
- The evaluation skill originally lived at `.codex/skills/kodex-proxy-evaluation`; the canonical copy now lives in the plugin package.

## Starting State

- Kodex exposed project preview CRUD, thread APIs, automation APIs, and skills catalog APIs through the gateway.
- Kodex did not expose app-server plugin marketplace/install APIs through the gateway.
- The frontend had no plugin install/status surface.
- The repo had a standalone `.codex/skills/kodex-proxy-evaluation` skill, but no real `kodex-control` plugin package.
- The gateway binary started only the HTTP gateway; it had no MCP subcommand.
- The gateway had no `/v1/self-control/...` namespace, no self-control provenance model, and no idempotent preview apply endpoint.

## Settled Decisions

- Create a real first-party plugin package at `plugins/kodex-control/`.
- Move `kodex-proxy-evaluation` into `plugins/kodex-control/skills/kodex-proxy-evaluation`.
- Add a repo marketplace at `.agents/plugins/marketplace.json`.
- Keep the Preferences > Plugins v1 UI focused on `Kodex Control`; it is a transitional adapter, not a generic plugin marketplace.
- The install button should automatically add/discover the bundled marketplace and install the plugin.
- Missing Caddy must not block plugin install.
- App-server-not-ready blocks install with degraded status.
- Gateway owns self-control policy and mutation semantics.
- MCP uses the official Rust SDK (`rmcp`) and exposes tools plus read-only resources/resource templates.
- MCP is gateway-hosted via a stdio subcommand such as `kodex-gateway mcp kodex-control`.
- The MCP subcommand calls the running gateway over HTTP using `KODEX_GATEWAY_URL`, defaulting to `http://127.0.0.1:8787`, and refuses non-loopback URLs unless explicitly allowed.
- Self-control automations default to paused unless the user explicitly requests enabled recurring work.

## Milestones

### 1. Package The Kodex Control Plugin

Scope: `plugins/kodex-control/`, `.agents/plugins/marketplace.json`, existing skill location, README docs.

Work:

- Create `plugins/kodex-control/.codex-plugin/plugin.json` with `skills: "./skills/"`, first-party interface metadata, and no MCP entry until the MCP milestone lands.
- Move `.codex/skills/kodex-proxy-evaluation` into `plugins/kodex-control/skills/kodex-proxy-evaluation`.
- Remove the repo-local standalone skill copy or leave only a clearly documented dev convenience if needed; the plugin copy is canonical.
- Create or update `.agents/plugins/marketplace.json` with a `kodex-control` entry using `policy.installation: "AVAILABLE"` and `policy.authentication: "ON_INSTALL"`.
- Update README skill installation docs to point at the plugin install flow rather than direct skill copying.

Exit criteria:

- Plugin manifest and marketplace JSON are valid JSON and use relative plugin paths.
- `python3 /Users/example/.codex/skills/.system/skill-creator/scripts/quick_validate.py plugins/kodex-control/skills/kodex-proxy-evaluation` passes.
- `rg kodex-proxy-evaluation README.md .codex plugins .agents` shows the plugin copy as canonical and no stale install instructions.

### 2. Gateway Focused Plugin Install API

Scope: `apps/gateway/src/app_server_api.rs`, `apps/gateway/src/routes/kodex_control_plugin.rs`, `apps/gateway/src/routes/mod.rs`, `apps/gateway/src/api.rs`, `apps/gateway/src/skills.rs`, README.

Work:

- Add typed app-server helpers for `marketplace/add`, `plugin/list`, `plugin/read`, and `plugin/install`, using checked-in schemas as the contract.
- Add a focused gateway route module for the transitional first-party install surface:
  - `GET /v1/kodex-control-plugin`
  - `POST /v1/kodex-control-plugin/install`
- Resolve the bundled marketplace path from a gateway config seam, for example `KODEX_KODEX_CONTROL_MARKETPLACE_PATH`, defaulting to repo-local `.agents/plugins/marketplace.json` when available.
- Implement status states such as `notInstalled`, `installed`, `appServerUnavailable`, and `setupError`.
- On install, automatically add/discover the bundled marketplace if needed, install `kodex-control`, invalidate the gateway skill cache, and emit or reuse `skills.changed`.
- Return `appsNeedingAuth`, auth policy, plugin summary, installed/enabled state, skill names, and MCP server names when available.
- Document that this focused endpoint is transitional and should be replaced by generic `/v1/plugins` APIs once generic plugin management is built.

Exit criteria:

- Backend route tests cover not-installed, install success, app-server unavailable, missing marketplace path, and skill-cache invalidation.
- `/openapi.json` includes the focused plugin endpoints and DTOs.
- `cargo fmt` passes for touched Rust code.
- Focused backend tests pass, including existing skills invalidation tests.

### 3. Preferences Plugins Tab

Scope: `apps/web/src/PreferencesModal.tsx`, a new plugin UI module if extraction is needed, `apps/web/src/api/client.ts`, `apps/web/src/api/queryKeys.ts`, `apps/web/src/styles/preferences.css`, generated API types.

Work:

- Regenerate frontend OpenAPI types after Milestone 2.
- Add typed frontend wrappers and query keys for focused `kodex-control` plugin status/install.
- Add a `Plugins` tab to `PreferencesModal`.
- Render a list-shaped plugins panel with one row/card for `Kodex Control`.
- Show status, installed/enabled state, skills/MCP summary, setup errors, `Install`, and `Refresh`.
- On install success, invalidate plugin status and relevant skills queries. Do not auto-run the skill, mutate the composer draft, or create threads.
- Document in code comments or plan notes that this list-shaped UI is a transitional first-party surface and should migrate to generic plugin list data later.

Exit criteria:

- Component tests cover tab navigation, loading/error states, install action, installed state, and skills query invalidation.
- `cd apps/web && npm test -- PreferencesModal` or the closest focused test command passes.
- `cd apps/web && npm run build` passes after generated types are updated.
- Browser validation with `$agent-browser` confirms Preferences > Plugins is reachable, text fits at desktop and mobile widths, and install/refresh controls do not overlap.

### 4. Self-Control Gateway Namespace And Provenance

Scope: `apps/gateway/src/routes/self_control.rs`, supporting service modules, `apps/gateway/src/store.rs`, `apps/gateway/src/api.rs`, `apps/gateway/src/routes/mod.rs`.

Work:

- Add a dedicated route module with clear module docs explaining that `/v1/self-control/...` is the agent-facing product-shaped boundary and raw CRUD routes should not be used by the MCP tools.
- Add shared DTOs for lightweight provenance:

  ```ts
  {
    sourceType: "kodex_control",
    sourceThreadId?: string,
    sourceTurnId?: string,
    sourceToolCallId?: string,
    requestedBy?: "user" | "agent",
    reason?: string
  }
  ```

- Store provenance durably for automations, either by adding dedicated nullable columns or a JSON provenance column in the automation table.
- Emit/audit provenance for preview apply and thread actions through gateway events where durable schema changes would be too broad.
- Add `GET /v1/self-control/status` returning gateway readiness, app-server readiness, preview subsystem state, and self-control version/capability flags.

Exit criteria:

- Migration tests cover new automation provenance storage.
- Backend tests cover `/v1/self-control/status`.
- OpenAPI schemas include self-control provenance DTOs and descriptions that distinguish these endpoints from raw CRUD routes.
- Existing automation tests still pass.

### 5. Idempotent Preview Apply Endpoint

Scope: `apps/gateway/src/routes/self_control.rs`, `apps/gateway/src/previews.rs`, `apps/gateway/src/routes/project_previews.rs`, `apps/gateway/src/store.rs`.

Work:

- Add `POST /v1/self-control/project-previews/apply`.
- Accept desired services, previews, routes, `projectId` or `projectCwd`, `dryRun`, and provenance.
- Resolve or create the target project by cwd only when explicitly requested by the request shape.
- Reconcile by stable names and service/preview ports to avoid duplicates.
- Return a structured diff with `created`, `updated`, `unchanged`, `deletedSkipped`, and route decisions.
- Do not delete services/routes by default; require explicit replacement/delete semantics in the request if deletion is ever added.
- Apply Caddy reload through the existing preview manager and include subsystem/service/preview status in the response.

Exit criteria:

- Backend tests cover dry-run no mutation, first apply creates services/preview/routes, second apply is unchanged, strip-prefix preservation, missing Caddy degraded status, and invalid route rejection.
- Same-user two-client correctness is satisfied because state is persisted in gateway store and returned through existing preview reads.
- OpenAPI and frontend generated types include the endpoint.

### 6. Self-Control Thread Tools Endpoint

Scope: `apps/gateway/src/routes/self_control.rs`, existing thread and turn helpers, queue helpers if needed.

Work:

- Add `POST /v1/self-control/threads` for project-scoped thread creation with provenance.
- Add `POST /v1/self-control/threads/{threadId}/input` for starting a turn or queueing input using the same routing rules as the composer path.
- Reuse gateway-owned thread settings, skill resolution, queue state, and broadcasts instead of duplicating browser logic.
- Require explicit target project/thread and return the authoritative thread/turn/queued-input result.
- Add conservative recursion guard fields to requests, such as `maxSelfControlDepth` or server-derived depth from provenance, even if enforcement is initially simple.

Exit criteria:

- Backend tests cover thread creation with provenance event, input to idle thread starts a turn, input to active thread queues or steers according to existing gateway rules, and invalid/stale thread errors are clear.
- Multi-client correctness is preserved through existing thread and queue events.
- OpenAPI reflects self-control thread routes with clear descriptions.

### 7. Self-Control Automation Endpoint

Scope: `apps/gateway/src/routes/self_control.rs`, `apps/gateway/src/routes/automations.rs`, `apps/gateway/src/automations.rs`, `apps/gateway/src/store.rs`.

Work:

- Add `POST /v1/self-control/automations` and `PATCH /v1/self-control/automations/{automationId}`.
- Default newly created self-control automations to paused unless the request explicitly includes an enabled/resume intent.
- Store self-control provenance durably on created/updated automations.
- Reuse existing automation validation, minimum interval enforcement, broadcasts, and scheduler recovery.
- Return automation status and whether it is paused by default.

Exit criteria:

- Backend tests cover paused-by-default creation, explicitly enabled creation/resume behavior, provenance persistence, update behavior, broadcasts, and scheduler recovery with provenance intact.
- Existing automation frontend/backend tests still pass.
- OpenAPI describes the paused default and explicit enable behavior.

### 8. Gateway-Hosted MCP Server

Scope: `apps/gateway/Cargo.toml`, `apps/gateway/src/main.rs`, a new `apps/gateway/src/mcp.rs` or similar, `plugins/kodex-control/.mcp.json`, plugin manifest update.

Work:

- Add the official Rust MCP SDK dependency (`rmcp`) with only the features required for a stdio server.
- Add a gateway subcommand, for example `kodex-gateway mcp kodex-control`.
- Implement MCP tools that call the local gateway HTTP self-control endpoints:
  - `get_status`
  - `apply_project_preview_config`
  - `create_thread`
  - `send_thread_input`
  - `create_automation`
  - `update_automation`
  - `pause_automation`
  - `resume_automation`
- Implement read-only MCP resources:
  - `kodex://status`
  - `kodex://projects`
  - `kodex://automations`
- Implement read-only resource templates:
  - `kodex://projects/{projectId}`
  - `kodex://projects/{projectId}/previews`
  - `kodex://threads/{threadId}`
  - `kodex://automations/{automationId}`
- Use `KODEX_GATEWAY_URL`, default `http://127.0.0.1:8787`.
- Refuse non-loopback gateway URLs unless an explicit opt-in such as `KODEX_ALLOW_REMOTE_SELF_CONTROL=1` is set.
- Update `plugins/kodex-control/.mcp.json` and `plugin.json` to expose the gateway MCP subcommand.

Exit criteria:

- Unit tests cover gateway URL validation, loopback defaults, and non-loopback refusal.
- MCP handler tests or a small stdio smoke exercise cover `tools/list`, one read-only resource, and a dry-run preview apply call against a test gateway.
- `cargo fmt` and focused gateway tests pass.
- Manual installed-plugin validation confirms Codex can discover the MCP server from the plugin.

### 9. End-To-End Dogfood And Documentation

Scope: README, `plans/index.md`, plugin docs/skill instructions, frontend and backend smoke coverage.

Work:

- Update README with:
  - Kodex Control plugin install behavior.
  - Preferences > Plugins path.
  - `kodex-gateway mcp kodex-control` purpose.
  - Self-control security assumptions and local/trusted-network constraints.
- Update `kodex-proxy-evaluation` skill instructions to include an explicit apply mode that uses Kodex Control tools only after user confirmation.
- Add dogfood validation for the target flow:
  - install plugin
  - refresh skills
  - use `$kodex-proxy-evaluation` to evaluate a repo
  - dry-run preview apply
  - apply preview config
  - verify preview status
- Update `plans/index.md` status as implementation progresses.

Exit criteria:

- README and skill docs contain no stale direct-copy installation path as the primary recommendation.
- Frontend build, backend focused tests, and MCP smoke validation pass.
- Browser validation with `$agent-browser` covers Preferences > Plugins and successful installed state.
- Review gate passes with no major issues remaining.

## Verification

Run verification progressively by milestone:

- Backend formatting and tests:

  ```bash
  cargo fmt
  cargo test
  ```

- Frontend generated API and build after OpenAPI changes:

  ```bash
  cd apps/web
  npm run generate:api
  npm test
  npm run build
  ```

- Plugin/skill validation:

  ```bash
  python3 /Users/example/.codex/skills/.system/skill-creator/scripts/quick_validate.py plugins/kodex-control/skills/kodex-proxy-evaluation
  ```

- Browser validation:
  - Use `$agent-browser` for Preferences > Plugins desktop and mobile smoke checks.
  - Confirm install/refresh controls are visible, non-overlapping, and status copy is accurate.

- MCP validation:
  - Run `kodex-gateway mcp kodex-control` in stdio smoke tests.
  - Confirm resources and tools are discoverable through the installed plugin runtime.

## Risks And Open Questions

- `rmcp` is an official Rust SDK but lower-tier than TypeScript/Python. Pin the version and keep the MCP scope tools/resources-only until runtime compatibility is proven.
- The gateway needs a robust way to locate the bundled marketplace path in dev and production. The plan assumes a config/env override plus a repo-local default.
- Generic plugin APIs and marketplace UI are intentionally deferred. The focused `kodex-control` endpoint should be documented as transitional and migrated later.
- Self-control recursion controls begin with provenance/depth checks but may need stronger policy once thread creation and automations are used heavily.
- Automations need careful UX and API copy because enabled recurring work is a persistent future action. The default remains paused for self-control-created automations.
- Plugin install should not depend on Caddy, but preview apply status should surface Caddy missing/degraded clearly.
