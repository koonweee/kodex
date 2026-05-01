# MVP Backend Revision 1 Plan

## Scope

Tighten backend ownership of concerns before frontend implementation begins. The current MVP backend is functionally complete, but too much HTTP routing, app-server JSON mapping, event ingestion, OpenAPI DTO definition, approval orchestration, static serving, and test surface lives in `apps/gateway/src/api.rs`.

This revision should keep existing behavior working while making the backend own the public product contract that the React client will consume.

## Principles

- Red first: every refactor or contract change starts with a failing route, adapter, contract, or store test.
- Preserve behavior unless this plan explicitly calls for a contract improvement.
- Keep gateway OpenAPI as the frontend contract. Do not shift stable product response shaping to TypeScript normalizers when Rust can own it.
- Keep app-server raw payloads at integration boundaries. Convert to product-shaped gateway DTOs before returning data needed by the frontend.
- Split by concern, not by abstraction theater. Add modules that clarify ownership and reduce coupling.
- Keep local/VPN-only deployment assumptions unchanged. Do not add gateway auth in this revision.

## Current Issues To Fix

- `api.rs` owns too many concerns: router construction, route handlers, DTOs, app-server request mapping, inbound event ingestion, approval brokering, SSE replay, static serving, and a large test suite.
- Several UI-facing routes return `RawAppServerResponse` with opaque `payload`, which weakens the generated OpenAPI contract for the frontend.
- App-server method strings and payload-building rules are embedded directly in HTTP handlers.
- Event ingestion and approval creation are tied to the HTTP API module even though they are backend workflow concerns.
- Tests verify behavior, but their location reinforces the monolith and makes future route/adapter changes harder to review.

## Target Ownership Boundaries

- `api`: router assembly, shared API state, public OpenAPI registration, and thin route module composition only.
- `routes::*`: HTTP extraction/response handling for one feature area at a time.
- `app_server`: process supervision plus the low-level JSON-RPC transport trait.
- `app_server_api` or `codex_client`: typed gateway-facing adapter over app-server methods such as thread list/read/start, turn start/steer/interrupt, account read/login/logout, rate limits, and model list.
- `events`: event replay, SSE streaming, event envelope helpers, and inbound notification ingestion.
- `approvals`: approval creation, supported approval method handling, decision validation, upstream response, and resolved-event emission.
- `store`: persistence only. Store DTOs may remain public when they are intentionally part of the gateway contract.
- `static_assets`: built frontend serving and SPA fallback.
- `schema`: app-server JSON Schema validation utilities only.

## Public Contract Direction

- Keep `CapabilitiesResponse`, `Project`, `EventEnvelope`, `Approval`, and approval list responses as product-shaped gateway DTOs.
- Replace `RawAppServerResponse` on frontend-critical endpoints where the UI needs stable fields:
  - thread list
  - thread detail, if the MVP detail view renders returned thread metadata
  - thread start/resume/fork/archive command responses, if the UI uses returned IDs or status
  - model list
  - account read
  - account rate limits
  - login start, if the UI needs a login URL or login ID
- It is acceptable to keep a `rawPayload` escape hatch inside product DTOs when app-server fields are still volatile, but stable UI fields must be first-class typed Rust fields.
- Do not model the entire app-server protocol. Normalize only fields required by the MVP frontend plan.
- Update `plans/mvp-frontend.md` if this revision changes or removes frontend-side normalizer responsibilities.

## Milestone 0: Safety Net and Module Map

Status: Proposed

Failing tests first:

- Add or tighten contract tests that describe the desired product-shaped responses for at least thread list, model list, account read, rate limits, and login start.
- Add a router inventory test that ensures all existing public routes remain present in OpenAPI.
- Add adapter tests that fail until app-server method mapping is moved out of handlers.

Implementation:

- Document the target module split in code by creating empty or minimal modules behind existing behavior.
- Move no behavior until the failing tests describe the expected post-revision shape.
- Identify which current `RawAppServerResponse` routes can become product-shaped in this revision.

Exit conditions:

- Failing tests exist for the first contract improvements.
- The plan for which routes remain raw versus product-shaped is encoded in tests or comments near the route DTOs.
- `cargo test` fails for the expected red-first reasons before implementation starts.

## Milestone 1: App-Server Adapter Layer

Status: Proposed

Failing tests first:

- Adapter maps `GET /v1/threads` inputs to `thread/list` with `cwd`, `cursor`, and `limit`.
- Adapter maps thread start/resume/fork/archive without HTTP handler involvement in JSON-RPC method names.
- Adapter maps turn start/steer/interrupt and preserves `expectedTurnId` for steer.
- Adapter maps account, login, logout, rate limits, and model list.

Implementation:

- Add a gateway-facing app-server adapter module over the existing `AppServer` trait.
- Move app-server method strings and JSON payload construction out of route handlers.
- Keep app-server JSON Schema validation in the adapter path before dispatch.
- Keep route handlers responsible only for HTTP extraction, store lookup when needed, adapter calls, and API response mapping.

Exit conditions:

- Route handlers no longer contain app-server method string literals such as `thread/list`, `turn/start`, `account/read`, or `model/list`.
- Adapter tests cover request mapping without spinning up the HTTP router.
- Existing route tests continue to pass.

## Milestone 2: Product-Shaped Frontend DTOs

Status: Proposed

Failing tests first:

- Thread list route returns a gateway DTO with typed thread entries for fields the MVP UI renders.
- Model list route returns typed visible model metadata and supports `includeHidden=false` by default.
- Account route returns typed unauthenticated/authenticated states needed by the account panel.
- Rate-limit route returns typed optional fields needed by the rate-limit badge.
- Login start returns typed fields needed to show login progress, especially login ID and auth URL when present.

Implementation:

- Add focused Rust response DTOs for frontend-critical routes.
- Normalize app-server payloads in backend adapter or response mapper code.
- Preserve `rawPayload` only where useful for debugging or forward compatibility.
- Keep unknown or unsupported app-server payload shapes from crashing the gateway; return a clear bad gateway-style error or a typed partial response where appropriate.
- Ensure OpenAPI generated from Rust exposes the product-shaped contract.

YAGNI boundaries:

- Do not normalize every app-server field.
- Do not implement frontend-only sorting, grouping, or formatting in the backend.
- Do not add a second handwritten API contract document.

Exit conditions:

- Frontend-critical endpoints no longer force the web client to inspect `RawAppServerResponse.payload` for stable MVP fields.
- OpenAPI includes typed schemas for the new responses.
- Contract tests cover missing optional fields and app-server payload drift for each normalized response.

## Milestone 3: Event and Approval Workflow Split

Status: Proposed

Failing tests first:

- Inbound Codex notifications are persisted and broadcast through an event service.
- Inbound supported server requests create both `codex.server_request` events and pending approvals.
- Inbound unsupported server requests create warning events without approvals.
- Approval decisions validate, claim, respond upstream, rollback on upstream failure, finish, and emit `approval.resolved`.

Implementation:

- Move inbound event ingestion out of `api.rs`.
- Move approval broker behavior out of HTTP route code where possible.
- Keep approval route handlers thin: list/get/decode decision/call approval service.
- Keep event metadata extraction close to event ingestion and covered by tests.

Exit conditions:

- Event ingestion and approval decision workflow can be tested without constructing the full HTTP router.
- HTTP approval routes still pass existing behavior tests.
- SSE and JSON replay behavior remain unchanged.

## Milestone 4: Route Module Split

Status: Proposed

Failing tests first:

- Router composition still exposes all expected public routes and OpenAPI paths.
- Static frontend fallback continues to serve SPA assets only when a valid build directory exists.
- API routes continue to win over frontend fallback.

Implementation:

- Split route handlers and DTOs into focused modules:
  - `routes/health.rs`
  - `routes/capabilities.rs`
  - `routes/projects.rs`
  - `routes/threads.rs`
  - `routes/turns.rs`
  - `routes/events.rs`
  - `routes/approvals.rs`
  - `routes/account.rs`
  - `routes/models.rs`
- Move static asset serving into a small dedicated module.
- Keep `api.rs` or `api/mod.rs` as composition and OpenAPI registration only.
- Move tests with the modules they primarily exercise; keep full-router integration tests for cross-cutting behavior.

Exit conditions:

- `api.rs` is no longer the main owner of feature behavior.
- Module names make ownership obvious to a frontend/backend contributor reading the repo for the first time.
- `cargo fmt` and `cargo test` pass.

## Milestone 5: Documentation and Frontend Plan Alignment

Status: Proposed

Failing tests first:

- Documentation-only changes do not need failing tests, but any contract behavior discovered during documentation must be backed by tests before implementation.

Implementation:

- Update `README.md` if backend commands, route behavior, or response shapes changed.
- Update `AGENTS.md` only if contributor workflow or testing rules changed.
- Update `plans/mvp-frontend.md` to remove frontend normalizer work that the backend now owns.
- Update [plans/index.md](index.md) when this revision starts or completes.

Exit conditions:

- README and frontend plan accurately describe the backend contract after revision.
- No frontend MVP milestone depends on parsing stable fields from opaque app-server payloads.
- `cargo fmt` and `cargo test` pass.
- Independent review has checked separation of concerns, OpenAPI output, route behavior, and docs alignment.

## Review Gate

- Run an independent review pass before marking this revision complete.
- Review should focus on ownership boundaries, accidental contract regressions, over-normalizing app-server fields, and whether route handlers stayed thin.
- Iterate until tests pass, OpenAPI reflects the intended frontend contract, docs are aligned, and no frontend-critical stable fields remain trapped in opaque raw payloads.
