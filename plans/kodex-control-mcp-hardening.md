# Kodex Control MCP Hardening Plan

## Status

Proposed.

## Context

Two Kodex Control MCP issues showed up while creating planning threads from this repository:

- `create_thread` can create a project-scoped thread, but `send_thread_input` can fail for the first message on that new thread. The failure path is `apps/gateway/src/routes/self_control.rs::should_queue_self_control_input`, which calls `app_server_api::CodexClient::thread_read` and therefore sends app-server `thread/read` with `includeTurns: true`. The current app-server can reject that on a thread with no first user message: `thread ... is not materialized yet; includeTurns is unavailable before first user message`.
- Parameterized MCP tools are advertised with empty or opaque input schemas. `apps/gateway/src/mcp.rs` uses one flattened `JsonToolParams` catch-all for `create_thread`, `send_thread_input`, preview apply, and automation tools. Runtime forwarding is flexible, but MCP clients see weak schemas such as no required `projectId`, `threadId`, or `input`, which can surface as effectively no-argument tools.

The target change is to make the end-to-end MCP flow reliable and self-describing:

1. A tool caller can create a Kodex thread and immediately send its first prompt through the guarded self-control input route.
2. MCP `tools/list` exposes accurate input schemas for the tools that require parameters.

## Current State

Code-established facts:

- `apps/gateway/src/mcp.rs::KodexControlMcp` hosts the stdio MCP server with `rmcp = 1.6.0`.
- The `rmcp` `#[tool]` macro generates tool input schemas from `Parameters<T>` when `T: schemars::JsonSchema`, or from an explicit `input_schema = ...` expression.
- `JsonToolParams` is a flattened `serde_json::Map<String, Value>`. It accepts arbitrary parameters but cannot communicate required fields or nested shapes to MCP clients.
- `send_thread_input` removes `threadId` from the MCP arguments and forwards the remaining JSON to `POST /v1/self-control/threads/{threadId}/input`.
- `create_thread`, preview apply, and automation tools forward argument JSON directly to gateway self-control endpoints.
- `apps/gateway/src/routes/self_control.rs::send_self_control_thread_input` intentionally keeps self-control input queue-first for active threads. This should not change as part of this plan.
- `should_queue_self_control_input` checks `state.thread_views.live_state(thread_id)` first, but when there is no loaded state it falls back to `CodexClient::thread_read`, which currently uses `includeTurns: true`.
- `apps/gateway/src/app_server_api.rs` already has not-materialized handling for history pagination through `is_thread_history_not_materialized_error`, but that helper is private and specific to `thread/turns/list`.
- `apps/gateway/src/turn_lifecycle.rs` has a broader private `is_thread_not_materialized_before_first_user_message` helper, but it is not available to the self-control route.
- Existing backend coverage includes `self_control_thread_create_and_input_use_gateway_state_and_source_labels`, but the fake app-server does not reproduce the real first-message `includeTurns` rejection.
- Existing MCP coverage in `apps/gateway/src/mcp.rs` and `apps/gateway/tests/kodex_control_mcp_stdio.rs` only verifies that tools can be listed and one preview dry-run call works. It does not assert input schemas for required parameters.

Constraints:

- MCP tools must keep using `/v1/self-control/...` instead of raw gateway CRUD or raw app-server access so provenance, audit behavior, and safety policy remain centralized.
- Self-control and automation input should remain queue-first for active threads unless a later product decision changes agent-originated steering policy.
- Fixing MCP tool schemas should not create a second public API contract that can drift silently from the self-control HTTP DTOs.
- This is backend/MCP behavior only. There is no browser-observable UI scope and no `$agent-browser` validation requirement.

## Target Behavior

- `create_thread` followed immediately by `send_thread_input` succeeds for a newly-created, no-message thread.
- If the app-server says a no-message thread is not materialized because `includeTurns` is unavailable before the first user message, self-control input treats the thread as idle/startable and calls `turn/start`.
- Stale, missing, unauthorized, or genuinely broken app-server read errors still propagate. The route should not broadly swallow `BadGateway`.
- Active self-control input still creates a source-labeled queued row with `sourceType: "kodex_control"` and the source id from `sourceToolCallId`, `sourceTurnId`, or `sourceThreadId`.
- MCP `tools/list` exposes concrete object schemas:
  - `create_thread` requires `projectId`;
  - `send_thread_input` requires `threadId` and `input`;
  - preview apply and automation tools advertise their important required fields instead of a catch-all empty object;
  - no-argument tools such as `get_status` remain empty-input tools.
- Runtime tool calls continue to forward through gateway self-control endpoints and return gateway JSON as text content, preserving current client compatibility.

## Milestones

### 1. Add Regression Coverage For First-Message Self-Control Input

Scope: `apps/gateway/src/routes/mod.rs`, `apps/gateway/src/routes/self_control.rs`, `apps/gateway/src/app_server_api.rs`, and `apps/gateway/src/turn_lifecycle.rs`.

Work:

- Add a route test that creates a self-control thread and immediately posts to `/v1/self-control/threads/{threadId}/input` while the fake app-server returns the real not-materialized `includeTurns` error for the queue-decision read.
- Assert the response is `200`, `action: "started"`, and the app-server receives `turn/start` for the first prompt.
- Assert no queued input row is created for that idle/new-thread first message.
- Keep or add a companion stale-thread test proving unrelated app-server errors still propagate instead of being converted to idle.
- Keep the existing active-thread self-control test proving active inputs still queue with `sourceType: "kodex_control"`.

Exit criteria:

- The new first-message test fails before implementation.
- Existing self-control route tests continue to describe queue-first active behavior.

### 2. Make Self-Control Queue Detection Materialization-Aware

Scope: `apps/gateway/src/routes/self_control.rs`, `apps/gateway/src/app_server_api.rs`, and `apps/gateway/src/turn_lifecycle.rs`.

Work:

- Add a shared helper for the app-server "not materialized before first user message" condition, or expose an existing helper from the most appropriate module.
- Narrow the helper to the specific first-message materialization case:
  - it should match `not materialized yet`;
  - it should match `before first user message`;
  - for this route, it should cover the observed `includeTurns is unavailable` message.
- Update `should_queue_self_control_input` so that this specific readback error returns `Ok(false)`, meaning idle/startable.
- Keep other app-server errors returning `Err(error)`.
- Avoid changing normal user `/v1/threads/{threadId}/input` behavior here; the steer-first user-input work belongs to `plans/tui-aligned-active-turn-steer.md`.
- Avoid changing self-control active input to use `turn/steer`; this route remains queue-first for active threads.

Exit criteria:

- Focused self-control route tests pass.
- `rg "includeTurns is unavailable|not materialized yet" apps/gateway/src` shows one intentionally shared classification path rather than new broad string checks scattered through route code.
- `cargo fmt --check` passes.

### 3. Replace Catch-All MCP Params With Advertised Tool Schemas

Scope: `apps/gateway/src/mcp.rs`, with possible small supporting derives or schema helpers near existing self-control DTOs.

Work:

- Replace `JsonToolParams` usage for required-argument tools with typed MCP parameter structs or explicit `input_schema` expressions.
- Prefer typed `Parameters<T>` where practical because `rmcp` already derives schemas from `schemars::JsonSchema`.
- Keep forwarding implementation simple:
  - deserialize typed tool params;
  - convert them back to JSON with `serde_json::to_value` or an explicit body builder;
  - call the existing self-control endpoint.
- Add schema coverage for at least:
  - `create_thread`: `projectId` required, optional model/effort/service tier/approval/permission/sandbox fields, optional `payload`, optional `source`, optional `maxSelfControlDepth`;
  - `send_thread_input`: `threadId` and `input` required, optional turn-start options, optional `source`, optional `maxSelfControlDepth`;
  - `create_automation`: `name`, `prompt`, `targetThreadId`, and `schedule` required;
  - `update_automation`, `pause_automation`, and `resume_automation`: `automationId` required;
  - `apply_project_preview_config`: project resolution fields plus `services` and `previews` shapes sufficiently described for tool callers.
- If deriving `schemars::JsonSchema` on existing gateway DTOs causes churn across app-server DTOs such as `UserInput`, use MCP-local schema structs for the outer tool contract and keep route-level forwarding tests to prevent drift.
- Preserve flexible JSON fields where the route intentionally accepts app-server-shaped data, such as thread `payload` and sandbox policy objects.

Exit criteria:

- `tools/list` reports non-empty `inputSchema.properties` and correct `required` entries for `create_thread`, `send_thread_input`, and automation id tools.
- Existing runtime tool calls keep working against a test gateway.
- No browser/frontend OpenAPI type generation is required unless HTTP route DTOs are intentionally changed.

### 4. Add MCP Schema And End-To-End Tool Tests

Scope: `apps/gateway/src/mcp.rs`, `apps/gateway/tests/kodex_control_mcp_stdio.rs`, and existing fake gateway/app-server test setup.

Work:

- Extend the in-process MCP test in `apps/gateway/src/mcp.rs`:
  - inspect `client.list_all_tools()` output;
  - assert `create_thread.inputSchema.required` contains `projectId`;
  - assert `send_thread_input.inputSchema.required` contains `threadId` and `input`;
  - assert `pause_automation` and `resume_automation` require `automationId`.
- Add a tool-call test for `create_thread` followed by `send_thread_input` against a fake gateway/app-server that reproduces the no-message materialization edge.
- Keep the stdio smoke test in `apps/gateway/tests/kodex_control_mcp_stdio.rs` lightweight, but add at least one schema assertion so the installed binary path also catches no-arg tool regressions.
- If schema shape differs slightly across `schemars` versions, assert stable high-signal facts: object type, property keys, and required field names.

Exit criteria:

- `cargo test -p kodex-gateway mcp` passes.
- `cargo test -p kodex-gateway kodex_control_mcp_stdio_lists_tools` passes.
- The tests fail if `JsonToolParams` or an equivalent empty schema is reintroduced for required-argument tools.

### 5. Documentation And Contract Cleanup

Scope: `README.md`, `plans/kodex-control-plugin.md` only if the implemented behavior changes their statements, plus `plans/index.md` status maintenance.

Work:

- Update README MCP copy only if the implementation changes user-facing tool names, required parameters, or setup commands.
- Keep `plans/kodex-control-plugin.md` historical unless implementation materially changes the completed scope description.
- Update this plan's status in `plans/index.md` when implementation starts or completes.
- Do not add handwritten standalone API contract docs; rely on MCP tool schemas and self-control OpenAPI DTOs.

Exit criteria:

- Documentation reflects any changed user-facing MCP behavior.
- `git diff --check` passes for touched docs/code.

## Verification

Run these after implementation:

- `cargo fmt --check`
- `cargo test -p kodex-gateway self_control_thread_create_and_input_use_gateway_state_and_source_labels`
- `cargo test -p kodex-gateway self_control_thread_input`
- `cargo test -p kodex-gateway mcp`
- `cargo test -p kodex-gateway kodex_control_mcp_stdio_lists_tools`

Manual smoke, when a local gateway and app-server are running:

1. Read `kodex://projects` through Kodex Control resources and identify the `kodex` project id.
2. Call MCP `create_thread` with that `projectId`.
3. Call MCP `send_thread_input` immediately with `threadId` and one text input.
4. Confirm the response is `action: "started"` and no raw localhost HTTP bypass is needed.

## Risks And Open Questions

- `schemars::JsonSchema` derives may not be cheap to add to existing gateway/app-server DTOs. If deriving on shared DTOs creates broad schema churn, use MCP-local schema structs plus route-forwarding tests.
- The not-materialized matcher is necessarily string-based today because app-server JSON-RPC errors are flattened into `ApiError::BadGateway`. Keep the match narrow and covered by tests; a later structured app-server error plan can remove this fragility.
- The plan intentionally does not change active self-control input to steer. If agent-originated live steering becomes desirable, that should be a separate product decision because it changes automation/self-control safety semantics.
