# Main frontend on the Mastra backend

Status: Active. Authorized 2026-10-07. Running log: [Mastra port](mastra-port.md).

## Fixed reference and scope

Initial main reference: `00d22832cb43a2784826b1eb9a25689d4b1e5eba`. Merge this exact commit into `codex/mastra-sdk-spike` once, then use it as the visual and interaction acceptance baseline. Main may advance independently; defer later-main discrepancies to a bounded final comparison. Do not change the main checkout or deploy the production service.

Deliver basically the Kodex frontend from this reference working end-to-end with the new TypeScript/oRPC/Mastra Code SDK backend. Preserve layout, controls, navigation and workflows with very little UI change. Reuse main's actual components rather than a separately reconstructed native shell/pane wherever practical. The extra in-pane thread title is an accidental difference to remove. Unimplemented features are work remaining, not evidence of native incapability.

Native-first concerns ownership, not a license to change the user experience. Mastra owns execution, conversation persistence, tools, memory, goals and scheduling where supported. Kodex supplies product-specific metadata, projections and coordination where needed. Preserve previous decisions: fresh dedicated profile and ChatGPT CLI login; no sandbox; TypeScript/oRPC; no app-server fallback or generic harness adapter; volatile queue loss after restart and native Stop accepted; queued messages retain their submission-time model/reasoning settings, with picker changes affecting new submissions (explicitly accepted 2026-10-07); effectively unlimited goal evaluations; MCP Apps initially deferred; plugins/extensions require their existing isolation assessment. No legacy data migration.

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
| Projects and directory picker | Main controls connected and native browser checks pass | Durable product registry, root/name/order, browse/create/update/delete and canonical cross-tab updates. Existing chats retain cwd/history; standalone chats work with no seeded projects. Final checkpoint checks recorded below. |
| Sidebar/chat metadata | Native inventory and basic titles | Native manual rename plus product archive/pin/order/notifications/membership metadata, standalone chats, paging, live activity and read state. |
| Models, reasoning, settings and composer | Native catalog/pickers, sparse shared settings, local draft choices working | Captured-version profile defaults service implemented. Native Fast setting is persisted and captured per submission; actual Responses-wire, canonical picker and draft tests pass. Context usage, attachments/skills/compaction remain. |
| Auth and quota footer | Dedicated native CLI OAuth works | Native account watch/logout and main footer/menu pass integration validation. A narrow ChatGPT usage reader uses native OAuth credentials; live dedicated-profile quota read succeeds. No sandbox and CLI login already accepted. |
| History, tools and subagents | Basic messages/live tools/restart working | Native paging, real tool/file/diff/image/reasoning presentation, read-only observers, parent/child metadata and existing subagent UI. |
| Approvals and questions | Not connected | Native live approval/suspension maps, claim APIs and persisted suspension recovery. Main's nonblocking async question cards are distinct from native suspended ask_user; assess a Mastra-executed Kodex tool with native reply signals. |
| Editable queue | Native queue editor/recovery working | Actual main panel/controllers, native signal IDs and conservative exact-receipt recovery validated. Canonical two-tab edits/reorder/remove, stale conflicts, Stop and restart pass. Unknown native queue entries remain partial/uneditable rather than fabricated. |
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

## Queue settings decision (2026-10-07)

User accepted Mastra's native enqueue-time settings. Pinned app-server queues content and resolves applied thread defaults when starting a queued turn; Mastra retains the prepared stream context from submission. Do not cancel/requeue waiting work merely to apply picker changes. Explicit queue replacement is a new native submission. Actual SDK fixture proves old queued work uses the old model while later submissions use the new model. Comparison sources: [pinned native queue runner](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/ext/queue/src/service.rs#L347), [turn input defaults](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/core/src/session/turn_input.rs#L91), [turn configuration](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/core/src/session/turn_context.rs#L992).

## Native settings slice

Existing main picker components now consume native available models and native thinking levels. Existing chats submit only sparse changed fields and render canonical watched settings; Send continues to omit defaults. Draft choices remain per-pane/local, passed at creation; native profile defaults apply to untouched drafts. Private captured file versions and a final pre-save check protect sparse native defaults edits from stale forms and intervening CLI writes. Native effective OpenAI reasoning is shown without rewriting retained raw overrides.

Validation: full frontend suite 1,132/1,132 and backend suite 70/70 passed before final focused review additions; native settings/effective-effort/Fast wire tests and frontend picker/model-availability tests cover subsequent bounded fixes. Three real-SDK browser shapes now additionally prove draft low reasoning, second-tab high update, and persistence across backend restart. Frontend typecheck/trim/build and independent reviews pass. Fast remains visible but unimplemented as a product setting; fixture proves supported provider-option forwarding, not paid live-provider acceptance.

## Project registry implementation constraint

Preserve main's existing-chat cwd when a project's root changes, and delete only project registry membership when deleting a project. The spike currently binds one native database/runtime to a CLI project path. Separate durable product project records from retained native runtime bindings before adding project CRUD: a changed project root needs a new binding for future chats, while old bindings/history remain discoverable; deleting a project detaches its bindings into standalone chats without deleting native storage. Recreating a project at the same directory must not silently reassign existing standalone chats. This is Kodex routing/product metadata, not a transcript store or harness dispatcher. Initial CLI seed IDs/runtime paths should remain usable; do not move existing native databases.

### Multiplexed browser transport

The expanded actual-browser fixture reproduced HTTP/1 connection exhaustion: account, catalog and selected-chat (or draft-defaults) streams occupy six connections across two tabs, starving ordinary RPC. Main already shares one gateway SSE stream; this is a Mastra integration transport gap, not a native harness limitation. Use the pinned oRPC WebSocket adapter to multiplex typed RPC and all iterators over one lazy connection per browser tab, retaining HTTP RPC for nonbrowser clients. This supplies the concrete requirement for moving beyond the earlier SSE-first preference and avoids a handwritten subscription protocol. Disconnects fail in-flight calls; only future calls establish a new socket. Existing read subscriptions refill after reconnect; admitted mutations are never replayed automatically. Verify cancellation, shutdown, two-tab convergence and backend restart.

### Account, Fast and transport acceptance (2026-10-07)

- Native credential storage owns account identity, refresh and logout. The existing account menu/footer is shared with the original backend; CLI sign-in guidance uses the dedicated profile. Watch revisions fence stale quota/logout results. ChatGPT quota uses a narrow fixed-endpoint reader with native credentials and allowlisted windows; live dedicated-profile read succeeded without a model request.
- Fast is a sparse native thread metadata setting, captured in each submitted request context and mapped by a public processor to the actual OpenAI Responses wire. Canonical snapshots own existing-chat picker display. Draft Fast is retained locally until native chat creation; ordinary Send does not replay settings.
- Shared browser transport resolves the reproduced two-tab HTTP/1 starvation. Actual SDK/browser flows pass desktop, narrow fine pointer and touch with one socket per tab, streaming, shared reasoning, queue/Stop, file tools, reload and killed-backend restart. Native oRPC performs multiplexing and cancellation. No proactive heartbeat or bounded detection of an OS/TCP-silent still-open connection is claimed.
- Frontend 1,152/1,152 tests, build and trim pass. One existing queue test exposed a submission-acknowledgment race under load; waiting for the first draft to clear fixes it without weakening its API assertions. Backend pre-transport regression suite 79/79 passes; focused native transport tests are recorded in the running log. Independent account/Fast/browser reviews and parent server review pass. Screenshot review confirms retained shell; existing WIP queue errors remain work for the next slice.

### Queue slice in progress

Reuse main’s actual queue list, edit/annotation dialog, recovery controls and touch layout through a shared presentation controller. Native execution and waiting work remain native; Kodex retains only a volatile editable projection, captured native preparation and uncertainty evidence. Canonical ChatSnapshot carries queue state, with per-queue epoch/revision checked by mutations. Enqueue-time options persist for reordered/untouched rows; explicit text edits prepare new input. Native memory-only persistence is not evidence of execution. Lost transport acknowledgments preserve text in the existing composer with an ambiguity warning; explicit uncertain results leave authoritative saved rows and never trigger automatic resend. Queue mutation replies do not replace watched snapshots.

### Queue acceptance (2026-10-07)

- Main queue list, annotations/edit modal, saved-input inspection, restore/dismiss/reconcile controls and touch layout are reused. Captured edit versions are not silently refreshed; conflicts remain visible inside the modal and retain its draft. Native partial coverage disables operations requiring a complete order while preserving exact-ID actions.
- Native queue IDs and confirmed selective cancellation govern edits and handoff. Counts are presentation/coverage/routing hints, never delivery receipts. A per-row private routing fence prevents memory-only persistence (including early synthetic message events) from being mistaken for admitted execution. Reconcile can resolve a known eligible exact-ID native receipt; absence, unknown IDs and native read failures remain uncertain. No retry dispatcher, durable queue or transcript store.
- Full frontend 1,166/1,166 and backend 93/93 pass; focused queue unit/native/oRPC tests 24/24, frontend slice 58/58, strict trim/build and independent review pass. Expanded actual SDK browser proof passes all three desktop/narrow mouse/touch configurations with edit/reorder/remove, two-tab stale edit rejection, Stop and killed-backend restart. Reviewed desktop screenshot; remaining top-level WIP errors are unported sidebar/goals, not queue acceptance.

### Project/sidebar slice implementation direction

Use a small dedicated product SQLite store via the already-evaluated libSQL client for projects, order, retained execution bindings, archive/pins and web notification preferences. These are Kodex product semantics; native projectPath tags describe execution cwd and are not a mutable project registry. Preserve CLI seed identities/storage paths, create retry keys, and roots[] metadata including zero/multiple-root correction; new execution requires exactly one root. Deleted projects do not reappear from unchanged CLI seeds, and recreated directories do not claim earlier standalone chats. Store no transcript or durable waiting input.

Native manual rename remains the preferred title primitive and must invalidate the canonical catalog. Validate a pinned placeholder at creation to avoid unnecessary native automatic naming while displaying bounded first-user-message preview; do not replace native Memory to change a naming default. Native row setters/rename/background usage writes are separate read-modify-write paths; record demonstrated regressions separately from source-level risk, and avoid putting unrelated product metadata in those rows.

### Decision pending: native lost-update repair

Actual published-SDK tests in `spikes/mastra-code-sdk/test/chat-title.native.test.ts` reproduce two native lost updates: rename restores a stale reasoning setting, and token-usage persistence restores a stale title/title pin after a successful rename. These are characterization tests, not passing correctness guarantees. Main delegates these fields to app-server’s partial-update primitives; the port must not silently call data loss accepted native behavior.

Pinned CodeSDK uses Core/Memory/LibSQL whole-row reads/saves across separate writers. Replacing only rename/usage with existing patchThread is insufficient: its metadata update still reads/merges/writes, and observational-memory writes can carry stale full metadata. A correct upstream-style repair must coordinate native field updates across Core, Memory and LibSQL. No SDK patch or replacement settings store has been introduced. Asked the user whether to maintain a pinned native fix or explicitly defer this limitation while continuing the port. Independent project/directory integration can proceed; title/settings correctness acceptance remains unresolved. Moving from CodeSDK to Core alone would retain these storage paths.

The same four-test proof verifies a supported pinned placeholder suppresses the separate automatic title request while preserving default native Memory/OM and durable manual rename outside the reproduced races. Its public vector-indexing hook is mocked to avoid unrelated FastEmbed downloads; model/observer/extraction/storage behavior is real with a local provider fixture.

### Next sidebar metadata boundary

Read-only audit of the frozen main and pinned SDK finds no Mastra public sidebar pin/order or archive primitive. Native `titlePinned` controls automatic naming, and native notification modes control CLI bells/system notifications. Extend the product registry for per-native-chat archive, global pin order and web-notification preferences (default enabled); main already owns the latter in its gateway. Join those flags onto native inventory without manufacturing missing native chats or storing transcripts. Project deletion changes membership only, so flags follow the retained binding/chat identity. Preserve canonical catalog/chat refills and two-client/restart coverage. Actual push/read state remains a later slice. Before implementing archive, verify ordinary active-run behavior against main; do not silently equate hiding with native Stop/delete. Main's explicitly pinned subagent exception must also be retained when child inspection/pinning is implemented.

### Project integration acceptance (2026-10-08)

Main’s directory picker, create dialog and project editor are reused through injected commands. One canonical catalog supplies projects to every pane; no per-pane inventory subscription or browser-owned membership. Standalone drafts no longer silently select the first project. Existing chats use their retained native binding for model discovery/execution even after root changes or deletion. Zero/multiple-root projects require correction for new execution, while existing chats remain usable. CLI `--project` seeds are optional and one-time; new product metadata lives in the dedicated profile’s `data/kodex.db`, separate from native history.

Full backend 110/110 and frontend 1,172/1,172 tests pass. Actual published-SDK/browser acceptance passes 6/6 across desktop, narrow mouse and touch: two-tab project creation/name/root changes, deletion, retained chat Send/history and killed-backend restart, plus the prior settings/queue/tool flow. Root reviewed the touch screenshot and independently reviewed frontend implementation; a separate agent reviewed backend, startup and browser fixtures. Final focused frontend tests/build/trim are recorded in the running log. Native lost-update repair remains a separate pending user decision; these tests do not resolve it.
