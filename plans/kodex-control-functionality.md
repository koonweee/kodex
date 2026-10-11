# Kodex Control functionality improvements

Status: Active

## Objective

Close the selected Control tool gaps with thin adapters over native app-server and existing gateway state: standalone chat creation, archived discovery/unarchive, compact turn reads, multi-thread waiting, and confirmed automation workflow gaps. Control remains built into Kodex. The saved desktop tool snapshot is a capability reference, not our wire contract or a mandate for API parity.

## Constraints

- Verify the pinned generated native schemas and upstream app-server README before integrating native behavior. Inspect existing routes first; reuse native semantics and existing gateway coordination.
- No model-generated summaries, summary storage, duplicate transcript/lifecycle state, general orchestration subsystem, automatic input-write retries or new background polling service.
- Bound pages, output sizes, target counts, wait duration and concurrent reads. Share compact formatting only where reads and waits actually overlap. Avoid unrelated refactors.
- Keep authoritative decisions in native/gateway state. Preserve canonical view revisions, invalidation/revert fencing, queue pause, approval and ambiguous-write guarantees. Control reads must not activate unrelated chats or acknowledge their completions.
- Keep existing explicit settings semantics and project-root checks. Projectless creation must not silently create a project or guess repository membership.
- Do not expose secrets through raw native/config payloads. Public DTOs generate OpenAPI and frontend types. Keep old user stores untouched.
- No deployment, production restart or push. Preserve unrelated untracked .kodex/ and tmp/.

## Milestones

### M1 — Projectless creation and archived management — Complete

1. Add failing focused behavior tests for create_thread/spawn_thread without projectId, successful initial input admission, explicit cwd validation and retained project-root restrictions. Inspect the existing browser/native standalone directory policy and use it; if no shared policy exists, choose and document the smallest native-supported policy instead of inventing a new workspace manager.
2. Make project membership optional throughout the relevant Control DTOs and native creation call. Preserve settings, correlation, guarded spawn receipts and uncertain-admission behavior for both kinds of chat.
3. Expose paginated archived discovery (separate tool or explicit existing list filter, whichever is simpler) and explicit unarchive. Reuse native archive lifecycle operations and canonical gateway invalidation; no archive database/cache.
4. Verify shared visibility with two clients: creation/unarchive appears through authoritative state and existing SSE, including a client recovering after missed events. Cover failures and pagination without loading unrelated chats.

Exit: agents can create standalone chats and discover/restore archived chats; existing project creation and input guarantees remain intact; generated contracts and docs match.

M1 implementation evidence (2026-10-11; independent review passed, no major issues):

- Control creation/spawn now allow omitted `projectId`, reuse the existing dated standalone directory policy, and retain guarded spawn receipts. The public DTOs, MCP schemas and generated frontend types agree.
- Archived discovery is `list_threads(archived: true)` with native cursor/project filtering and a 1–100 page bound; restore calls native `thread/unarchive` and publishes the existing catalog refill.
- Six focused HTTP tests cover standalone creation/input replay, explicit directory validation, second-client event replay, archived filters/pagination/page bounds and malformed reads. The gateway library suite passed (702 passed, 3 intentionally ignored).
- A disposable-home test against pinned Codex 0.160.0 passed the standalone create → completed input → archive → discover → restore flow. Frontend build, existing archive/unarchive replay test and both trim scripts passed. No UI implementation changed; cross-client evidence uses gateway events/replay and the existing frontend lifecycle regression.

### M2 — Compact reads and multi-thread supervision

1. Design a small deterministic compact turn representation from current native/canonical history: turn identity/status, user and assistant text, optional bounded tool output, pagination and explicit truncation. No inference calls or stored summaries. Preserve meaningful tool errors and distinguish failed reads from empty history.
2. Add a compact read mode/tool with bounded pages and validated limits. Avoid full-history scans or transcript hydration merely to summarize status. Test long outputs, empty/in-progress/failed turns, pagination and stale/reverted reads.
3. Add wait_threads with a bounded target list and duration. Return when a target completes or needs attention; include per-target errors and compact current progress at timeout. Use per-target opaque cursors to avoid redelivering already-observed results. Define initial-snapshot and zero-timeout behavior explicitly.
4. Reuse existing authoritative lifecycle/read paths and event mechanisms. A cursor must identify observed completion/progress safely across restart and revert; do not derive completion from idle alone or treat a gateway event cursor as transcript coverage. Avoid durable wait state or per-item ledgers.
5. Test mixed targets, completion/attention, already-completed inputs, cursor reuse, partial failures, timeout, restart/reconnect/revert and cancellation cleanup. Shared formatting should be reused by reads and waits when appropriate. Document transport cancellation limitations honestly; do not promise desktop user-input wake behavior unless supported.

Exit: compact reads and waiting provide bounded useful results, no duplicate completed text with a current cursor, and no changes to shared state from observation. No model-generated summaries or new lifecycle storage.

### M3 — Automation workflow audit and confirmed improvements

1. Inspect existing automation scheduler, Control tools, run records and notifications. Record concrete support/gaps for recurring work in an existing chat, a new standalone/project chat per run, and notification preferences. Desktop heartbeat/cron naming is not a required implementation structure.
2. Implement only confirmed gaps needed for those workflows using existing scheduler/run/native primitives. Reuse existing notification controls where adequate; keep notification policy out of prompts. Do not create a second scheduler or general startup activation index.
3. If a workflow requires substantial new persistence, activation or synchronization machinery, document the user need, simpler existing workflow and costs before selecting an implementation. Ask only if a material product decision cannot be resolved from this agreed scope.
4. Cover scheduling/admission versus inference completion, paused queues, uncertain acknowledgments, duplicate explicit attempts and cross-client convergence as relevant. Keep passing workflows unchanged.

Exit: a source-grounded audit records what already works and what was changed or requires a product decision; confirmed in-scope improvements are implemented and tested. Do not claim heartbeat/cron parity from tool names alone.

## Verification and review

- Start behavior changes with failing tests when practical. Prefer closest domain/API tests and meaningful native proofs in disposable homes; no tests solely for tool-name strings.
- Each coherent implementation chunk receives independent read-only review, fixes and relevant validation before commit. Use the repository-specified review model. Commit at sensible milestone boundaries.
- Run Rust formatting, relevant tests and backend trim; regenerate contracts for public DTO changes. For changed frontend contracts/callers run build/typecheck, relevant tests and frontend trim. Use bundled Chromium/browser evidence for affected UI flows, and same-user two-client tests for shared mutations.
- Update Control documentation, README/AGENTS when their workflows change, this plan and plans/index.md as milestones advance. Complete only when all milestone exits, generated artifacts and independent review pass.

## Explicit exclusions

Terminal output; opening/navigating existing UI content; moving threads between projects; marking unread; managed worktrees; PR attachments; usage visibility/reset; sharing or host handoff; plugin management; custom sidebar sections/sorting; desktop voice/screen/LaTeX/Spaces integrations. No changes to these features merely to match the desktop catalog.
