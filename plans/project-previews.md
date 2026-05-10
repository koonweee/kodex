# Project Previews Plan

## Status

Complete. Gateway-owned, Caddy-backed project preview settings are implemented across backend, generated OpenAPI/frontend types, project settings UI, docs, tests, browser smoke validation, and real Caddy proxy smoke.

## Goal

Add per-project preview settings so a Kodex gateway bound to a Tailscale address can expose project-local dev servers, such as a Vite frontend on `127.0.0.1:3000` and a NestJS backend on `127.0.0.1:4000`, through stable tailnet-reachable preview URLs.

The gateway must own all durable preview state, public port allocation, Caddy config generation, Caddy supervision, and runtime status. The web UI only renders gateway snapshots and submits gateway mutations.

## Settled Product Decisions

- v1 is manual configuration only. Kodex does not discover services, parse framework configs, or start project dev servers.
- Caddy is the only supported proxy implementation.
- Caddy is not bundled. Users install Caddy separately; `KODEX_CADDY_BINARY` can point at a non-`PATH` binary.
- Kodex starts and supervises an isolated Caddy process. It must not mutate or reload a system/user-managed Caddy instance.
- Missing Caddy, Caddy startup failure, admin endpoint conflict, or preview port conflict degrades the preview subsystem but does not prevent the main gateway from starting.
- Caddy state lives under the Kodex data dir, for example `~/.kodex/previews/caddy/`, with Kodex-owned config, data, config-home, and logs.
- Preview listeners bind to the same concrete IP as `KODEX_BIND` by default. If `KODEX_BIND` is `0.0.0.0`, previews require explicit `KODEX_PREVIEW_BIND`.
- Upstreams are loopback-only. v1 service configuration accepts protocol and port, not arbitrary target hosts.
- Services and previews are separate:
  - A service is a local loopback target, such as `Frontend` on port `3000`.
  - A preview is a public listener, such as `App` on port `13000`, rooted at one service with optional route entries to other services.
- Public ports belong to previews, not services.
- Default public port is `10000 + root service local port` when available, then the next free port in `10000-19999`. User overrides are allowed but validated for conflict.
- Public preview ports are globally unique across all projects. Local service ports are not globally unique.
- v1 route model is intentionally small:
  - one root service per preview
  - optional simple path routes such as `/api/*`
  - `stripPrefix` boolean for path routes
  - no regex routing, host routing, arbitrary rewrites, header routing, or raw Caddy snippets
- Users create services and previews explicitly. There is no wizard, no common preset, and no automatic direct preview per service.
- Non-obvious UI settings need tooltips, especially public port, route path, and strip prefix.
- Save and apply is one gateway operation. The gateway persists desired state, regenerates Caddy config, validates/reloads Caddy, and returns the new desired config plus live status.
- SQLite stores desired preview configuration only. Runtime status is computed from the Caddy supervisor, reload results, port conflicts, and health checks.
- Previews have an `enabled` flag. Disabled previews remain persisted but are omitted from generated Caddy config.
- Referenced services cannot be deleted or changed incompatibly until dependent preview routes are removed. Safe edits like name and health path are allowed.
- v1 uses OpenAPI CRUD and refetch; no preview SSE events are required.
- The UI surface is a routed project main pane such as `/projects/{projectId}`, opened from an explicit project-row action. Project-title click continues to expand/collapse the sidebar project row.
- Status is reported at subsystem, preview, and service levels so the UI can distinguish Caddy missing, Caddy degraded, preview disabled, public port conflict, and local upstream unreachable.

## Non-Goals

- No built-in Caddy binary packaging.
- No Tailscale Serve adapter.
- No Kodex path-prefix proxy hanging off the gateway's own HTTP router.
- No host-per-service or wildcard DNS mode.
- No TLS management in v1.
- No public internet exposure claims. This remains localhost or trusted-tailnet only.
- No gateway auth.
- No arbitrary upstream hosts or internal-network proxying.
- No framework-specific config mutation.
- No browser-local durable preview state.
- No SSE-driven live preview status in v1.

## Existing Implementation Check

Backend:

- `apps/gateway/src/config.rs` defines `Config`, `ServerConfig`, and env loading. Default `server.bind` is `127.0.0.1:8787`; current env overrides include `KODEX_BIND`, database paths, Codex binary args, uploads dir, and frontend dist.
- `apps/gateway/src/main.rs` starts optional subsystems after `AppState::new`, then serves the router. The app-server supervisor failure path keeps the gateway running with degraded readiness; previews should follow that style.
- `apps/gateway/src/store.rs` owns SQLite migrations and gateway-owned tables. The current `projects` table contains only `id`, `name`, `cwd`, `created_at`, and `updated_at`.
- `apps/gateway/src/routes/projects.rs` exposes `GET /v1/projects`, `POST /v1/projects`, and `GET /v1/projects/{project_id}`.
- `apps/gateway/src/api.rs` registers public routes and OpenAPI schemas. New preview DTOs must be Rust DTOs here and must generate `/openapi.json`.
- `README.md` documents local/VPN-only deployment and current env overrides. Preview setup must update these docs once implemented.

Frontend:

- `apps/web/src/api/client.ts` wraps generated OpenAPI types from `apps/web/src/api/generated/schema.ts`; preview types and wrappers must come from regenerated OpenAPI.
- `apps/web/src/api/queryKeys.ts` centralizes TanStack Query keys.
- `apps/web/src/shell/navigation.ts` currently supports `/`, `/threads/{threadId}`, and `/automations`; it needs a project pane route.
- `apps/web/src/shell/KodexShellView.tsx` switches between `thread` and `automations` main panes; it needs a project pane branch.
- `apps/web/src/threads/WorkspaceSidebar.tsx` already uses project-title click for collapse/expand and has project-row trailing actions. Add an explicit project settings/previews action instead of changing title behavior.
- `apps/web/src/App.tsx` is the shell coordinator and should delegate project preview UI to a feature module rather than accumulating form behavior inline.

## Source Of Truth

- SQLite desired config is the durable source of truth for services, previews, preview routes, enabled flags, and chosen public ports.
- The gateway preview manager is the source of truth for live subsystem/service/preview status.
- Caddy config is generated output from gateway state, not user-owned configuration.
- The browser can hold unsaved form drafts, but saved state and status must come from gateway fetches/mutations.

## Data Model

Add gateway tables in `apps/gateway/src/store.rs`:

```sql
create table if not exists project_preview_services (
    id text primary key,
    project_id text not null,
    name text not null,
    protocol text not null,
    local_port integer not null,
    health_path text not null,
    created_at text not null,
    updated_at text not null,
    foreign key (project_id) references projects(id)
);

create table if not exists project_previews (
    id text primary key,
    project_id text not null,
    name text not null,
    public_port integer not null unique,
    root_service_id text not null,
    enabled integer not null,
    created_at text not null,
    updated_at text not null,
    foreign key (project_id) references projects(id),
    foreign key (root_service_id) references project_preview_services(id)
);

create table if not exists project_preview_routes (
    id text primary key,
    preview_id text not null,
    path_pattern text not null,
    service_id text not null,
    strip_prefix integer not null,
    sort_order integer not null,
    created_at text not null,
    updated_at text not null,
    foreign key (preview_id) references project_previews(id),
    foreign key (service_id) references project_preview_services(id)
);
```

Validation rules:

- `protocol` accepts `http` in v1. Reserve schema room for future `https`.
- `local_port` must be `1..=65535`.
- `public_port` must be in configured preview range, default `10000..=19999`, unless a future config explicitly widens it.
- `health_path` must start with `/`.
- `path_pattern` must start with `/` and should be either `/` or a simple prefix wildcard like `/api/*`; route table entries exclude `/` because preview root is represented by `root_service_id`.
- `root_service_id` and route `service_id` must belong to the same project as the preview.
- Deleting a referenced service is rejected.
- Changing service protocol or port while referenced is rejected in v1; name and health path edits remain allowed.
- Disabled previews still reserve their public port unless a future product decision changes this. This keeps URLs stable.

## API Shape

Add a preview route module, for example `apps/gateway/src/routes/project_previews.rs`, and register it in `apps/gateway/src/api.rs`.

Routes:

- `GET /v1/projects/{projectId}/previews`
- `POST /v1/projects/{projectId}/preview-services`
- `PATCH /v1/projects/{projectId}/preview-services/{serviceId}`
- `DELETE /v1/projects/{projectId}/preview-services/{serviceId}`
- `POST /v1/projects/{projectId}/previews`
- `PATCH /v1/projects/{projectId}/previews/{previewId}`
- `DELETE /v1/projects/{projectId}/previews/{previewId}`
- `POST /v1/projects/{projectId}/previews/{previewId}/routes`
- `PATCH /v1/projects/{projectId}/previews/{previewId}/routes/{routeId}`
- `DELETE /v1/projects/{projectId}/previews/{previewId}/routes/{routeId}`
- `POST /v1/project-previews/reload` for an explicit repair action when status is degraded

Response shape should include desired config plus live status:

```ts
type ProjectPreviewSettingsResponse = {
  subsystem: PreviewSubsystemStatus;
  projectId: string;
  services: ProjectPreviewService[];
  previews: ProjectPreview[];
};
```

Status levels:

- Subsystem: `available`, `degraded`, `disabled`
  - include `caddyFound`, `caddyRunning`, `adminReachable`, `bindAddress`, `adminAddress`, `lastReloadError`
- Service: `reachable`, `unreachable`, `unknown`
  - include `healthUrl`, `lastCheckedAt`, `lastError`
- Preview: `active`, `disabled`, `degraded`
  - include `url`, `publicPort`, `lastReloadError`, `routeErrors`

## Caddy Management

Add a gateway module such as `apps/gateway/src/previews.rs` with small internal seams:

- `PreviewManager`
  - loads desired config from `Store`
  - computes bind/admin/data paths from `Config`
  - generates Caddy config from enabled previews
  - starts/stops the isolated Caddy process
  - reloads Caddy after mutations
  - computes status snapshots
- `CaddySupervisor`
  - starts `caddy run --config <generated> --adapter caddyfile` or equivalent
  - uses Kodex-owned `XDG_DATA_HOME` and `XDG_CONFIG_HOME` equivalents if practical
  - never talks to a system Caddy admin endpoint
  - uses a Kodex-owned localhost admin endpoint
- `CaddyConfigRenderer`
  - pure function from desired previews to Caddyfile text
  - validates duplicate listeners and references before rendering
- `PreviewHealthChecker`
  - probes loopback service health paths
  - computes live service status on demand or with short gateway-owned caching

Generated Caddyfile shape:

```caddyfile
{
  admin 127.0.0.1:20191
  auto_https off
}

100.x.y.z:13000 {
  handle_path /api/* {
    reverse_proxy 127.0.0.1:4000
  }

  handle {
    reverse_proxy 127.0.0.1:3000
  }
}

100.x.y.z:14000 {
  reverse_proxy 127.0.0.1:4000
}
```

When `stripPrefix` is false, render a Caddy route that preserves the path, such as `handle /api/*` instead of `handle_path /api/*`.

## Configuration

Extend `apps/gateway/src/config.rs`:

- `KODEX_CADDY_BINARY`
  - default: `caddy`
- `KODEX_PREVIEW_BIND`
  - default: concrete IP from `KODEX_BIND`
  - required when `KODEX_BIND` is unspecified wildcard `0.0.0.0` or `[::]`
- `KODEX_PREVIEW_PORT_RANGE`
  - default: `10000-19999`
- `KODEX_CADDY_ADMIN_BIND`
  - default: `127.0.0.1:20191`
- `KODEX_PREVIEW_DATA_DIR`
  - default: `${KODEX_DATA_DIR:-~/.kodex}/previews`

README setup docs must explain installing Caddy on macOS and Linux and keeping Kodex preview exposure trusted-tailnet-only.

## Frontend UX

Add a new project main pane:

- Route: `/projects/{projectId}`
- Opened from an explicit project row action in `WorkspaceSidebar.tsx`, likely an `Info` or `Settings` icon.
- Project title click continues collapse/expand.
- `KodexMainPane` expands to include `project`.
- Main pane layout should be an operational settings view, not a marketing page.

Project pane sections:

- Project overview: name, cwd, preview subsystem status summary.
- Services table:
  - name
  - protocol
  - local port
  - health path
  - status
  - actions
- Previews table:
  - name
  - URL/open action
  - enabled
  - public port
  - root service
  - route summary
  - status
  - actions
- Preview route editor:
  - path pattern
  - target service
  - strip prefix with tooltip

Tooltips:

- Public port: remote tailnet-facing port Caddy listens on.
- Route path: browser path prefix routed away from the root service.
- Strip prefix: whether `/api/users` reaches the backend as `/users` or `/api/users`.

State:

- Use TanStack Query with generated API wrappers.
- Use form-local draft state only while editing.
- Refetch after every mutation because the gateway returns authoritative config/status after save-and-apply.
- No preview SSE in v1.

## Milestones

### 1. Gateway Data Model And API Contract

Status: Complete.

Scope: `apps/gateway/src/store.rs`, new preview DTOs/routes, OpenAPI registration, route tests.

Work:

- Add preview service, preview, and route tables to `Store::migrate`.
- Add store helpers for create/list/update/delete with referential integrity and public port uniqueness.
- Add DTOs and routes for project preview CRUD.
- Add public port allocation helper: `10000 + local_port` first, then next free in configured range.
- Add validation for loopback-only service model, route paths, enabled previews, and project ownership.
- Register paths and schemas in `apps/gateway/src/api.rs`.

Exit criteria:

- Focused backend tests cover migration, port allocation, conflict rejection, referential integrity, and route validation.
- `/openapi.json` includes preview routes and DTOs.
- `cargo test -p kodex-gateway` passes.

### 2. Caddy Supervisor And Config Application

Status: Complete. The implementation restarts the isolated Kodex-owned Caddy child after config changes rather than using the admin reload API in v1; the external API still exposes this as save-and-apply/reload repair.

Scope: new `apps/gateway/src/previews.rs` or equivalent, config envs, startup/reload lifecycle.

Work:

- Add preview config fields/env loading to `apps/gateway/src/config.rs`.
- Add Caddy binary discovery with missing-binary degraded status.
- Start an isolated Caddy child process from `apps/gateway/src/main.rs` after state creation.
- Generate Caddy config from enabled previews only.
- Use a Kodex-owned admin endpoint and data/config dirs.
- Apply save-and-reload after every preview mutation.
- Detect admin port and public preview port conflicts and report degraded status.
- On shutdown, stop the Kodex-owned Caddy process.

Exit criteria:

- Backend tests use a fake Caddy executable or process fixture to verify startup, reload, missing binary, and conflict behavior without requiring real Caddy.
- Config tests cover `KODEX_PREVIEW_BIND` required with wildcard gateway bind.
- `cargo test -p kodex-gateway` passes.

### 3. Health And Status Snapshots

Status: Complete.

Scope: gateway status computation and preview list response.

Work:

- Add service health checks against `http://127.0.0.1:{port}{healthPath}`.
- Include subsystem, service, and preview status in `GET /v1/projects/{projectId}/previews`.
- Keep runtime status out of SQLite.
- Add explicit reload/repair endpoint for degraded Caddy state.
- Ensure disabled previews are omitted from Caddy config but shown as disabled.

Exit criteria:

- Backend tests cover reachable/unreachable/unknown service status, disabled preview status, and degraded subsystem reporting.
- Same desired config after restart produces a fresh status snapshot without relying on stored runtime status.
- `cargo test -p kodex-gateway` passes.

### 4. Generated Frontend Types And API Client

Status: Complete.

Scope: `apps/web/src/api/generated/schema.ts`, `apps/web/src/api/client.ts`, `apps/web/src/api/queryKeys.ts`.

Work:

- Regenerate frontend OpenAPI types after gateway preview DTOs land.
- Add typed API wrappers for preview list and mutations.
- Add query keys for project preview settings.
- Keep wrapper types sourced from generated schemas only.

Exit criteria:

- `cd apps/web && npm run generate:api` updates generated schema.
- `cd apps/web && npm test -- --run` or focused API/client tests pass.
- `cd apps/web && npm run build` passes.

### 5. Project Pane UI

Status: Complete. The v1 UI supports creating services, previews, and routes; toggling and deleting previews; deleting services/routes; and showing gateway-owned status. Update APIs exist in the gateway/client for future editable rows, but inline edit controls are intentionally not part of the v1 manual-create surface.

Scope: `apps/web/src/shell/navigation.ts`, `apps/web/src/shell/KodexShellView.tsx`, `apps/web/src/App.tsx`, `apps/web/src/threads/WorkspaceSidebar.tsx`, new `apps/web/src/projects/` feature module.

Work:

- Add `/projects/{projectId}` route parsing and path helper.
- Add `project` to main pane switching.
- Add explicit project-row action to open the project pane.
- Build a project pane component that renders gateway preview settings and status.
- Add service forms, preview forms, route forms, enabled toggle, delete controls, open-preview action, and diagnostics.
- Add tooltips for public port, route path, and strip prefix.
- Use Mantine controls and keep feature CSS scoped to layout/density.
- Refetch after each mutation; do not derive durable active status in React.

Exit criteria:

- Focused frontend tests cover opening the project pane, rendering gateway-owned status, creating services, displaying previews/routes, and invoking the gateway reload path. Backend tests cover update/delete validation, disabled previews, reference rejection, port conflicts, and degraded status.
- Existing sidebar collapse/expand behavior remains covered.
- `cd apps/web && npm test -- --run` passes.
- `cd apps/web && npm run build` passes.
- `$agent-browser` validates desktop and mobile project pane layout, including no text overlap and reachable controls.

### 6. Docs And Operational Smoke

Status: Complete. Setup docs, browser smoke, and real Caddy root/API proxy smoke are complete.

Scope: `README.md`, `apps/gateway/config/production.env.example`, plans index.

Work:

- Document Caddy installation requirement and `KODEX_CADDY_BINARY`.
- Document preview env overrides and bind behavior.
- Document trusted-tailnet-only assumption for preview ports.
- Add local smoke steps for Vite/Nest-style services:
  - frontend on `3000`
  - backend on `4000`
  - app preview on `13000`
  - `/api/*` route with strip prefix
- Update `plans/index.md` status as work starts/completes.

Exit criteria:

- README clearly explains setup, envs, and security assumptions.
- Production env example includes preview config comments or safe defaults.
- Agent-browser smoke confirmed the project pane against a temporary gateway with frontend/backend services, an `App` preview, and `/api/*` route at desktop and 390px mobile widths.
- Real Caddy smoke confirmed an `App` preview on `13000` with frontend root/proxy traffic and a stripped `/api/*` backend route. The local host already had listeners on `3000` and `4000`, so equivalent temporary services ran on `3100` and `4100` for the smoke.

## Verification

Backend:

- `cargo fmt`
- `cargo test -p kodex-gateway`
- Inspect `GET /openapi.json` after route/schema changes.

Frontend:

- `cd apps/web && npm run generate:api`
- `cd apps/web && npm test -- --run`
- `cd apps/web && npm run build`
- `cd apps/web && npm run test:e2e` if project pane routing is covered by Playwright.

Browser:

- Use `$agent-browser` for project pane desktop and mobile checks.
- Verify project row settings action opens `/projects/{projectId}` without changing collapse behavior.
- Verify service/preview forms do not overflow at phone width.
- Verify status diagnostics are readable and controls are reachable.

Operational:

- With Caddy installed, configure a frontend service on `3000`, backend service on `4000`, app preview on `13000`, and API route `/api/*`.
- Confirm `http://<preview-bind>:13000/` proxies to frontend.
- Confirm `http://<preview-bind>:13000/api/...` proxies to backend with the configured strip behavior.
- Confirm `http://<preview-bind>:14000/` works only if the user explicitly creates a direct backend preview.
- Confirm missing Caddy, occupied admin port, occupied public port, disabled preview, and stopped upstream service all show distinct gateway-reported statuses.

## Risks And Open Questions

- Caddy process isolation details need careful implementation. `apps/gateway/src/main.rs` currently supervises app-server but no second child process; preview supervisor shutdown must not leak processes.
- Caddy admin API and config reload behavior should be integration-tested with a fake binary first. A real-Caddy smoke can be manual or feature-gated.
- WebSocket upgrade support should work through Caddy's `reverse_proxy`, but Vite HMR may still need project-side `server.hmr` config when accessed through a remote IP/port. Document this if observed during smoke.
- Disabled previews reserving public ports keeps URLs stable but may surprise users resolving conflicts. This is the v1 decision; revisit only with user feedback.
- `0.0.0.0` gateway bind needs strict preview-bind validation to avoid accidental exposure beyond Tailscale.
- No SSE in v1 means two open tabs can show stale preview settings until refetch/focus. This is acceptable because saved state remains gateway-owned; add preview invalidation SSE only if stale panes become a real issue.
