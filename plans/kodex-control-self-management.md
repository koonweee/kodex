# Kodex Control Self-Management Plan

## Status

Complete.

## Context

Kodex Control already exposes a first-party plugin, a gateway-hosted MCP stdio server, and guarded self-control endpoints for preview apply, thread creation/input, and automation create/update/pause/resume. The next scope is to make Kodex able to operate the local gateway on the user's behalf across six concrete areas:

1. read/discovery tools,
2. full thread lifecycle tools,
3. atomic thread/agent spawning,
4. automation management parity,
5. approval handling with policy,
6. event/watch semantics.

The implementation should keep self-control as a gateway-owned product boundary. MCP tools should continue to call `/v1/self-control/...` routes rather than raw gateway CRUD routes so provenance, safety policy, audit events, and cross-client state reconciliation stay centralized.

Relevant code seams:

- Plugin package and MCP declaration: `plugins/kodex-control/.codex-plugin/plugin.json`, `plugins/kodex-control/.mcp.json`, `plugins/kodex-control/bin/kodex-control-mcp`.
- MCP server implementation and tests: `apps/gateway/src/mcp.rs`, `apps/gateway/tests/kodex_control_mcp_stdio.rs`.
- Self-control routes and provenance: `apps/gateway/src/routes/self_control.rs`.
- Route registration and OpenAPI: `apps/gateway/src/routes/mod.rs`, `apps/gateway/src/api.rs`.
- Existing thread APIs to wrap: `apps/gateway/src/routes/threads.rs`, `apps/gateway/src/routes/turns.rs`.
- Queue APIs and state: `apps/gateway/src/queue.rs`, `apps/gateway/src/store.rs`.
- Approval APIs and broker: `apps/gateway/src/routes/approvals.rs`, `apps/gateway/src/approvals.rs`, `apps/gateway/src/events.rs`, `apps/gateway/src/schema.rs`.
- Automation APIs and scheduler: `apps/gateway/src/routes/automations.rs`, `apps/gateway/src/automations.rs`.
- Event replay/SSE: `apps/gateway/src/events.rs`, `apps/gateway/src/routes/events.rs`, `apps/gateway/src/events_replay.rs`.
- App-server adapter methods: `apps/gateway/src/app_server_api.rs`.

## Current State

- `KodexControlMcp` currently exposes `get_status`, `apply_project_preview_config`, `create_thread`, `send_thread_input`, `create_automation`, `update_automation`, `pause_automation`, and `resume_automation`.
- MCP resources currently include `kodex://status`, `kodex://projects`, `kodex://automations`, and templates for project, project previews, thread by id, and automation by id.
- `/v1/self-control/...` currently supports status, idempotent preview apply, project-scoped thread create/input, and automation create/update/pause/resume.
- Self-control provenance is represented by `SelfControlSource` and audit events such as `self_control.thread_created` and `self_control.thread_input`.
- `maxSelfControlDepth` exists on thread self-control calls, but `enforce_self_control_depth` only rejects `0`; it is not a real recursion or spawn budget yet.
- Existing gateway routes already support many operations that Kodex Control should wrap: project/thread reads, timeline pages, thread attach/resume/fork/archive/rename/settings/pin/seen/subagents, queue list/retry/steer/delete, approval list/decision, automation list/get/delete, and event replay/SSE.
- `AGENTS.md` requires gateway-owned shared state, two-client correctness for shared thread/project/session behavior, OpenAPI DTOs as the public API contract, and review/test gates before completion.

## Settled Decisions

- Keep Kodex Control local/trusted-network only. Do not imply public remote-control safety.
- Add self-control REST endpoints first, then expose MCP tools/resources over those endpoints.
- Reuse existing gateway route helpers where possible instead of duplicating raw app-server behavior in MCP.
- Add concrete MCP input schemas for every new parameterized tool, following the existing hardening tests in `apps/gateway/src/mcp.rs`.
- Treat approval mutation as the sensitive area: read/list approval tools can be direct, but approval decisions must go through a self-control policy route that defaults to deny-only or human-confirm-required behavior. Broad autonomous approval is out of scope for this plan.
- Treat browser UI as out of scope for this plan unless implementation later decides to surface new controls in Preferences. Existing plugin install UI may remain unchanged.

## Milestones

### 1. Self-Control Read And Discovery Surface

Scope: `apps/gateway/src/routes/self_control.rs`, `apps/gateway/src/mcp.rs`, `apps/gateway/src/api.rs`, `apps/gateway/src/routes/mod.rs`.

Work:

- Add read-only self-control endpoints for project and thread discovery:
  - `GET /v1/self-control/projects`
  - `GET /v1/self-control/projects/{projectId}`
  - `GET /v1/self-control/threads`
  - `GET /v1/self-control/sidebar/threads` or a compact self-control equivalent backed by `get_sidebar_threads`
  - `GET /v1/self-control/threads/{threadId}`
  - `GET /v1/self-control/threads/{threadId}/timeline/pages`
  - `GET /v1/self-control/threads/{threadId}/subagents`
  - `GET /v1/self-control/threads/{threadId}/queued-inputs`
- Reuse existing helpers from `routes::projects`, `routes::threads`, and `queue` where the response shape is already gateway-owned.
- Add query DTOs for cursor/limit/project filtering instead of passing arbitrary JSON maps.
- Extend MCP resources/templates:
  - `kodex://sidebar/threads`
  - `kodex://threads?projectId={projectId}`
  - `kodex://threads/{threadId}/timeline`
  - `kodex://threads/{threadId}/subagents`
  - `kodex://threads/{threadId}/queued-inputs`
- Add MCP tools where resources are awkward for clients, such as `list_projects`, `list_threads`, `get_thread`, and `list_thread_queue`.
- Ensure response payloads expose enough identifiers for follow-up mutation tools: project id, thread id, queue id, automation id, approval id, cursors, and current live state.

Exit criteria:

- Backend route tests cover project list/read, project-filtered thread list, thread detail, timeline page cursor validation, subagent list, and queued input list through `/v1/self-control/...`.
- MCP tests assert new resource templates and tool schemas are listed.
- `cargo fmt --check` passes.
- `cargo test -p kodex-gateway self_control` and `cargo test -p kodex-gateway mcp` pass for the expanded surface.

### 2. Thread Lifecycle Self-Control Tools

Scope: `apps/gateway/src/routes/self_control.rs`, `apps/gateway/src/routes/threads.rs`, `apps/gateway/src/routes/turns.rs`, `apps/gateway/src/mcp.rs`.

Work:

- Add guarded self-control wrappers for thread lifecycle actions:
  - attach/resume: `POST /v1/self-control/threads/{threadId}/attach`
  - fork: `POST /v1/self-control/threads/{threadId}/fork`
  - rename: `PATCH /v1/self-control/threads/{threadId}/name`
  - settings: `PATCH /v1/self-control/threads/{threadId}/settings`
  - archive: `POST /v1/self-control/threads/{threadId}/archive`
  - pin/unpin: `POST` and `DELETE /v1/self-control/threads/{threadId}/pin`
  - mark seen: `POST /v1/self-control/threads/{threadId}/seen`
  - compact: `POST /v1/self-control/threads/{threadId}/compact`
  - interrupt current: `POST /v1/self-control/threads/{threadId}/interrupt-current`
- Add self-control provenance/audit events for every mutation, with `sourceThreadId`, `sourceTurnId`, `sourceToolCallId`, `requestedBy`, and `reason` preserved.
- Keep shared state gateway-owned by delegating to existing route helpers or extracting pure service functions where calling handlers directly would be brittle.
- Preserve current lifecycle semantics:
  - self-control input remains queue-first for active target threads;
  - selected-thread stop still routes through current-turn gateway state;
  - settings updates use app-server-native `thread/settings/update`.
- Add MCP tools with explicit schemas: `attach_thread`, `fork_thread`, `rename_thread`, `update_thread_settings`, `archive_thread`, `pin_thread`, `unpin_thread`, `mark_thread_seen`, `compact_thread`, `interrupt_thread`.

Exit criteria:

- Backend tests cover each self-control lifecycle endpoint and prove audit events are appended for mutations.
- Same-user two-client correctness is covered for at least rename, settings, archive, pin, and interrupt by asserting gateway events/cache-relevant broadcasts are emitted from the existing authoritative paths.
- MCP `tools/list` schema assertions cover required `threadId` and required action-specific fields such as `name`.
- Existing route tests for normal thread lifecycle behavior still pass.

### 3. Atomic Spawn Workflow

Scope: `apps/gateway/src/routes/self_control.rs`, `apps/gateway/src/store.rs`, `apps/gateway/src/events.rs`, `apps/gateway/src/subagents.rs`, `apps/gateway/src/mcp.rs`.

Work:

- Add an orchestration endpoint such as `POST /v1/self-control/thread-spawns`.
- Accept target project or target cwd, first input, optional role/nickname/goal metadata, optional thread creation options, source provenance, and a real self-control budget.
- Implement create-thread-plus-first-input atomically at the product level:
  - create the target thread,
  - persist a parent/source relationship in gateway state or a dedicated spawn/audit event,
  - send the first input,
  - return thread id, input action, queued input or turn payload, and source/audit identifiers.
- Add idempotency support keyed by `sourceToolCallId` or an explicit `idempotencyKey`, so a retried MCP call does not spawn duplicate work.
- Replace the current no-op recursion guard with meaningful depth/budget enforcement for spawn-capable routes:
  - decrement inherited depth on nested self-control calls,
  - reject when exhausted,
  - record the remaining budget in audit payloads.
- Decide whether this workflow should create normal project threads only or also support chat-thread cwd creation. Default to project-scoped spawning first; chat spawning can be a follow-up unless needed by implementation.
- Add MCP tool `spawn_thread` with required `projectId` and `input`, plus optional `role`, `nickname`, `goal`, creation options, `idempotencyKey`, and provenance.

Exit criteria:

- Backend tests cover create-and-start success, active target queue behavior where relevant, idempotent retry, source provenance, parent/source linkage, and exhausted depth rejection.
- Store tests cover any new spawn/idempotency table or event projection.
- MCP tests cover `spawn_thread` schema and a successful call against a fake gateway/app-server.
- Existing `create_thread` and `send_thread_input` tools continue to work as lower-level primitives.

### 4. Automation Management Parity

Scope: `apps/gateway/src/routes/self_control.rs`, `apps/gateway/src/routes/automations.rs`, `apps/gateway/src/automations.rs`, `apps/gateway/src/store.rs`, `apps/gateway/src/mcp.rs`.

Work:

- Add self-control read and lifecycle endpoints for automation parity:
  - `GET /v1/self-control/automations`
  - `GET /v1/self-control/automations/{automationId}`
  - `DELETE /v1/self-control/automations/{automationId}`
  - `POST /v1/self-control/automations/{automationId}/run-now`
  - `POST /v1/self-control/automations/validate`
- Reuse existing validation from `routes::automations::{validate_name_and_prompt, validate_target_thread, repeat_every_seconds}`.
- Keep self-control automation creation paused by default unless `enabled: true` is explicit.
- Add `run-now` by enqueueing the automation prompt into the target thread with `sourceType: "automation"` or a new source subtype that still identifies the automation id and self-control source.
- Return scheduler-relevant fields already present in `AutomationDto`: status, paused reason, next run, last run, last queued input id, last error, consecutive failures, and provenance.
- Add MCP tools/resources: `list_automations`, `get_automation`, `delete_automation`, `run_automation_now`, and `validate_automation`.

Exit criteria:

- Backend tests cover self-control list/get/delete, run-now queue creation with source labels, validation failures, paused-by-default preservation, and scheduler recovery with provenance intact.
- MCP tests cover automation tool schemas and read resources.
- Existing automation scheduler and frontend automation tests continue to pass.

### 5. Approval Handling With Policy

Scope: `apps/gateway/src/routes/self_control.rs`, `apps/gateway/src/routes/approvals.rs`, `apps/gateway/src/approvals.rs`, `apps/gateway/src/schema.rs`, `apps/gateway/src/store.rs`, `apps/gateway/src/mcp.rs`.

Work:

- Add read-only self-control approval endpoints:
  - `GET /v1/self-control/approvals`
  - `GET /v1/self-control/approvals/{approvalId}`
- Add a policy-checked decision endpoint:
  - `POST /v1/self-control/approvals/{approvalId}/decision`
- Define a self-control approval policy DTO with conservative defaults:
  - allow `denied` decisions by default;
  - require explicit `requestedBy: "user"` or an allowlisted policy token for approvals;
  - reject broad autonomous approval unless a later plan adds a durable user-configured policy.
- Validate decision payloads through existing `schema::validate_approval_response`.
- Preserve the existing single-use approval resolution behavior in `approvals::decide_approval`.
- Add audit events such as `self_control.approval_decision_requested` and `self_control.approval_decision_applied`, including policy result and source provenance.
- Add MCP tools: `list_approvals`, `get_approval`, `deny_approval`, and `decide_approval_with_policy`. Avoid a simple `approve_approval` tool until policy is explicit enough to avoid accidental broad grants.

Exit criteria:

- Backend tests cover pending approval list/read, deny allowed, approve rejected without policy, approve accepted with explicit user-requested policy, invalid payload rejection, and concurrent decision single-use behavior.
- MCP schema tests cover required `approvalId` and decision fields.
- Existing approval broker tests still pass.
- The plan's local/trusted-network security language is reflected in README only if user-facing behavior or setup changes.

### 6. Event And Watch Semantics

Scope: `apps/gateway/src/routes/self_control.rs`, `apps/gateway/src/events.rs`, `apps/gateway/src/events_replay.rs`, `apps/gateway/src/mcp.rs`, `apps/gateway/src/store.rs`.

Work:

- Add read-only self-control event replay endpoints:
  - `GET /v1/self-control/events`
  - `GET /v1/self-control/debug/events` only if needed for diagnostics, not default tool use.
- Add targeted wait tools at the MCP layer rather than exposing long-running HTTP handlers first:
  - `wait_for_thread_idle`
  - `wait_for_thread_event`
  - `wait_for_automation_run`
  - `wait_for_approval`
  - `wait_for_queue_empty`
- Implement wait tools by polling self-control read endpoints or event replay with cursor/watermark parameters and bounded timeouts. If MCP supports streaming progress cleanly in the current `rmcp` version, add progress later; do not require it for v1.
- Use gateway event sequence numbers as the comparable cursor. Avoid deriving durable truth from client-observed event order without a sequence.
- Return structured timeout results instead of treating timeout as an MCP protocol failure.
- Add event-kind allowlists for normal tool use so MCP callers do not need raw app-server event taxonomy to wait for common conditions.

Exit criteria:

- Backend tests cover self-control event replay filtering by project/thread/cursor and reject invalid query combinations such as `threadId` plus `excludeThreadId`.
- MCP tests cover wait success and timeout against a fake gateway/event source.
- Same-user multi-client behavior remains convergent because waits observe gateway-owned events and thread snapshots, not browser-local state.

## Verification

Run focused checks after each milestone:

- `cargo fmt --check`
- `cargo test -p kodex-gateway self_control`
- `cargo test -p kodex-gateway mcp`
- `cargo test -p kodex-gateway kodex_control_mcp_stdio_lists_tools`

Run broader checks before marking the plan complete:

- `cargo test -p kodex-gateway`
- Start a local gateway and inspect `/openapi.json` to confirm new public DTOs/routes are generated.
- Manually smoke the installed plugin MCP server:
  1. read `kodex://status`;
  2. list projects and threads;
  3. spawn a thread with a first prompt;
  4. wait for thread idle or approval;
  5. list and manage an automation;
  6. verify no raw localhost HTTP bypass is needed by the agent.

If a frontend Preferences surface is added during implementation, also run:

- `cd apps/web && npm test`
- `cd apps/web && npm run build`
- `$agent-browser` validation for Preferences > Plugins/MCP at desktop and narrow mobile widths.

## Risks And Open Questions

- Real recursion budget enforcement is currently missing. Implementing spawn without this would make self-control loops too easy to create.
- Approval policy is intentionally conservative. If users want autonomous approvals, that needs a separate durable policy design with clear user consent, allowed approval classes, and auditability.
- MCP wait tools may be limited by the current `rmcp` transport and client timeout behavior. Start with bounded polling and structured timeout results.
- Idempotent spawn likely needs a new store table or durable event lookup. Reusing only audit event scanning may work but could become fragile under high event volume.
- Some app-server lifecycle actions, such as unarchive or richer search, may exist in the checked-in schema but are not wrapped by current gateway routes. Add gateway routes first only when needed by this plan, and verify against `apps/gateway/app-server-schema/<version>/json`.
