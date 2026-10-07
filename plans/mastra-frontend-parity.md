# Main frontend on the Mastra backend

Status: Active. Authorized 2026-10-07. Running log: [Mastra port](mastra-port.md).

## Fixed reference and scope

Initial main reference: `00d22832cb43a2784826b1eb9a25689d4b1e5eba`. Merge this exact commit into `codex/mastra-sdk-spike` once, then use it as the visual and interaction acceptance baseline. Main may advance independently; defer later-main discrepancies to a bounded final comparison. Do not change the main checkout or deploy the production service.

Deliver basically the Kodex frontend from this reference working end-to-end with the new TypeScript/oRPC/Mastra Code SDK backend. Preserve layout, controls, navigation and workflows with very little UI change. Reuse main's actual components rather than a separately reconstructed native shell/pane wherever practical. The extra in-pane thread title is an accidental difference to remove. Unimplemented features are work remaining, not evidence of native incapability.

Native-first concerns ownership, not a license to change the user experience. Mastra owns execution, conversation persistence, tools, memory, goals and scheduling where supported. Kodex supplies product-specific metadata, projections and coordination where needed. Preserve previous decisions: fresh dedicated profile and ChatGPT CLI login; no sandbox; TypeScript/oRPC; no app-server fallback or generic harness adapter; volatile queue loss after restart and native Stop accepted; effectively unlimited goal evaluations; MCP Apps initially deferred; plugins/extensions require their existing isolation assessment. No legacy data migration.

## Decision rule

Proceed autonomously on implementation, routine design choices, tests, fixes, reviews and coherent commits. Stop for user clarification when a genuine Mastra limitation would require changing an existing UI/workflow or another unresolved product tradeoff. Present the exact baseline behavior, native capability/evidence, concrete alternatives and smallest recommendation. Previously accepted differences do not need reapproval. Do not replace unsupported work with successful-looking stubs or silently remove controls. Ordinary WIP errors may remain during development, but do not count as completed parity for in-scope workflows.

## Work sequence

1. Merge the pinned main reference and restore passing builds/tests. Record conflicts/resolutions and verify that main's shared layout is retained.
2. Inventory every browser workflow and backend dependency against the reference. Track each as working, implementing, explicitly deferred/accepted, or awaiting a product decision. Prioritize blockers to normal chat use; do not create a duplicate handwritten wire contract.
3. Port in reviewable slices: native settings/model/auth display and composer; project/chat metadata and sidebar; history/live tools/approvals/questions/queue operations; goals/automations; file previews, terminal and Control; retained PWA/read state/notifications. Refine ordering from the inventory and native capabilities.
4. Reuse established frameworks/native primitives and infer oRPC wire types from the backend. Keep presentation transformations in named modules. Shared state must converge across tabs/reload/reconnect/restart; browser-local drafts and layout remain local.
5. Validate each slice with risk-appropriate failing tests first, real SDK fixtures, independent review and the reference UI/browser flows. Use bundled Chromium for desktop fine pointer, narrow fine pointer and touch as appropriate. Preserve meaningful existing tests; update tests only for explicit accepted semantic differences.
6. At the end, compare later main changes once and reconcile small discrepancies without reopening the entire baseline. Escalate genuinely material new scope rather than silently broadening work.

## Exit conditions

- Main-reference frontend appearance and interactions retained, including no duplicate pane title or replacement shell drift.
- In-scope workflow inventory works against the actual Mastra-backed server; exceptions are explicitly accepted/deferred, not hidden behind unimplemented routes.
- Actual SDK model/tool persistence and lifecycle exercised through the browser; two-client convergence and restart behavior demonstrated for shared mutations.
- Relevant backend/frontend tests, builds, trim and independent reviews pass; setup and running logs current; coherent commits in the separate worktree.
- Final later-main comparison recorded. No production cutover without separate authorization.

## Progress

- Frozen main merged and workflow inventory recorded. Initial integration validation passes; native settings/composer parity is active.

## Workflow inventory against the frozen reference

The reference UI path is App → KodexShellView → WorkspaceProvider → ThreadPane → ThreadPaneComposerBridge → Composer/TimelineView. Preserve these actual components; retire prototype NativeShell/NativeThreadPane/NativeComposer replacements as their domain wiring is ported. Keep inferred oRPC types, native snapshot lifecycle and named display mappings. Existing endpoint names below describe dependencies, not a new wire-contract specification.

| Workflow | Current Mastra status | Remaining work / native ownership |
| --- | --- | --- |
| Bootstrap, deep links, docking, appearance | Basic native host/watch and shared shell work | Reuse main's exact header, tabs, sidebar peek, pane actions, loading and scroll behavior; preserve browser-local drafts/layout. |
| Projects and directory picker | CLI roots only | Durable Kodex project registry, root/name/order, browse/create/update/delete and cross-tab updates; no fake native project API. |
| Sidebar/chat metadata | Native inventory and basic titles | Native manual rename plus product archive/pin/order/notifications/membership metadata, standalone chats, paging, live activity and read state. |
| Models, reasoning, settings and composer | Text Send/Queue/Stop working | Native model catalog/switch/thinking values, sparse settings coordinator, actual context usage, attachments/skills/compaction; prove Fast provider-option wire behavior before judging support. |
| Auth and quota footer | Dedicated native CLI OAuth works | Native account labels/status available; no public SDK quota reader found. Investigate response-header availability and concrete preservation options before requesting a product decision. No sandbox and CLI login already accepted. |
| History, tools and subagents | Basic messages/live tools/restart working | Native paging, real tool/file/diff/image/reasoning presentation, read-only observers, parent/child metadata and existing subagent UI. |
| Approvals and questions | Not connected | Native live approval/suspension maps, claim APIs and persisted suspension recovery. Main's nonblocking async question cards are distinct from native suspended ask_user; assess a Mastra-executed Kodex tool with native reply signals. |
| Editable queue | Native enqueue/count/Stop working | Native signal IDs and selective synchronous cancellation can support a volatile display projection and delivery retirement. No public list/edit/reorder/CAS API; test cancel/requeue handoff and failure behavior before deciding whether native ownership suffices. |
| Goals | SDK proof only | Native objective/state/update/clear plus existing controls, concurrency and usage/status; unlimited evaluation already accepted. |
| Automations | Native persistent scheduler proof only | Native schedules CRUD/pause/resume/run/history/timezone and tested Session-context wake hook behind actual automation UI. |
| Uploads, file previews and skills | Native skill-discovery proof only | Durable upload references/native file parts, workspace preview validation, image/diff/Markdown views, native skill list/reload/invocation and attachment queue editing. |
| MCP and Control | Namespaced native discovery/reload proof | Existing accepted CLI/file setup, actual host-state Control tools, MCP resource/HTTP/OAuth/isolation checks; browser sparse config coordination if retained. MCP Apps explicitly deferred. |
| Integrated terminal | Not connected | Real host-owned PTY supervision and /terminals WebSocket transport; reuse main xterm, fonts, links, reconnect/resize/touch behavior. Agent shell tool is not a substitute. |
| Read state, notifications and PWA | Not connected | Authoritative native completion identity + product seen/version/presence/preferences, cross-tab badges, actual push and exact-completion previews; migrate worker fetches too. Provider push proof remains manual. |

Scope correction: main has no conversation fork/revert controls. Duplicate pane means local docking. Native cutoff-copy/delete does not prove observational-memory rewind, but that is not a blocker for a nonexistent UI workflow.

## Initial merge validation

- Three conflicts resolved in App imports, composer Send routing and extracted sidebar rail. Preserve main's queueIfPending behavior on its original path and native command injection on Mastra. New main rail/status components use shared presentation inputs, with explicit absent-timestamp sorting fallback.
- Build/trim and independent merge review pass; native two-tab/restart browser acceptance remains green across all three viewport/input modes.
- Full pinned-main baseline itself has 18 frontend failures (including stale queueIfPending assertions and changed layout/title fixtures). The merged snapshot also has 18 failures; repeated isolated comparisons show no demonstrated new merge failure. Updated eight stale test files to main's actual behavior while preserving delivery, loading and authoritative-refill assertions. Independent review of the test changes is clear. Full merged suite passes: 1,125 tests in 154 files. Main checkout remains untouched.
