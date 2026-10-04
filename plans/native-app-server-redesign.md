# Native App-server Redesign

## Status

Proposed. Created 2026-10-04. Implementation has not started.

This is the implementation plan for the [native capability audit](../docs/audits/2026-10-04-app-server-native-audit.md) and subsequent product decisions. The audit contains the source evidence and qualifications; this plan defines scope, dependencies, deletion work and acceptance gates. The initial target is Codex **0.160.0 with its experimental schema**, not whichever executable happens to be on `PATH`. A later version change requires checking the contract again.

## Outcome and settled scope

Kodex becomes a responsive browser interface over an independently owned app-server. App-server owns Codex execution and durable Codex state. Kodex keeps the browser presentation, transport and additional features whose user value justifies their maintenance.

- Use a dedicated, real Kodex `CODEX_HOME` and owned app-server process. Do not attach to desktop or share its home, credentials, databases or runtime.
- Start with fresh native, gateway and instance-bound browser state. Do not import history, projects, settings, schedules, credentials or queued work. Do not build migration maps, conversion, backfills, legacy readers or dual writes. Leave old storage intact and unopened by the replacement runtime.
- Keep automations, MCP Apps, MCP setup, Kodex Control tools and supported callers, docking, PWA extras, and queued-row steering.
- Accept native queue restart behavior: ordinary queued messages remain stored and wait until their chat is loaded again after app-server restart. Do not add a startup activation index or automatically resume every chat with queued work. Automations still activate their own targets for the retained unattended workflow.
- Keep the integrated terminal with **process supervision independent of app-server**. This is an explicit exception to adopting native execution: native process handles end with their originating app-server connection. Retain gateway-owned terminal lifetime; do not add a separate daemon or promise survival across gateway restarts.
- Remove remote development-server previews, including the Caddy supervisor and preview-specific tools/skill. File previews, uploads, generated app surfaces, trusted-VPN access to Kodex and operator-managed HTTPS remain.
- Remove automatic AI-generated titles. Use native preview text and manual naming.
- Replace complete subsystems when that leaves a simpler maintained design. Preserve retained workflows and meaningful behavior tests, not old modules, internal APIs, table layouts or implementation-specific assertions.

The user's general direction is to keep behavior simple and native wherever possible. Apply that default to remaining design choices: queued messages use native thread settings when executed; existing-thread settings are shared instead of per-pane one-shot overlays; sidebar organization uses native sections/order, including a “Pinned” section convention, instead of overlapping pin models and attention-driven resorting. Per-pane unsent text/attachment drafts remain local. Accept native limitations instead of preserving old semantics through extra machinery, except where an explicitly retained workflow requires a justified extension. These defaults do not need separate product-approval gates; revisit them only if implementation reveals a conflict with a retained requirement or correctness guarantee.

## Target ownership

| Owner | Responsibilities | Why Kodex still needs its part |
| --- | --- | --- |
| App-server | Accounts/auth, native config, projects and thread associations, sections/order, thread settings and metadata, history, turns, ordinary queued input/dispatch, subagent discovery, skills/plugins/MCP runtime, native approvals | Use native identifiers, requests, notifications and persistence. Do not mirror these as competing durable authorities. |
| Gateway adapter | Exact-version transport, generated contracts, shared command routing, request correlation, native approval mirroring, bounded snapshot/live projection, invalidation and reconnect recovery | Browsers need one coherent view and must not choose lifecycle actions from stale local state. Native history is not a replayable browser event stream. |
| Gateway extensions | Temporary queue-to-steer transfers; automation schedules/run bookkeeping; read markers and notification delivery; terminal supervision; uploads/file serving; MCP App host state/grants; Kodex Control facade | These support explicitly retained workflows that the inspected native primitives do not fully provide. Each keeps only its own necessary state and policy. |
| Browser | Rendering, Dockview layouts, drafts, focus/scroll, responsive input, app iframes, terminal display and PWA lifecycle | These are presentation or device concerns. Submitted work, approvals and shared settings remain authoritative upstream of React. |

Keep Rust/axum, generated OpenAPI and frontend types, owned stdio, and browser SSE. Keep terminal WebSocket I/O where needed. An SDK, in-process app-server, generic RPC tunnel or new browser transport is not required to achieve this redesign.

## Delivery rules and dependencies

Use disposable fresh instances throughout development. Initialize the user-facing replacement instance only after the complete release gate passes. Reset development fixtures when schema/ownership changes; do not build migration infrastructure to carry them through the milestones.

The core dependency is **M1 → M2 → M3 → M4**. Stable native client-message identity in snapshots and live events is required before queue promotion can reconcile delivery. Broader history optimization may be split from M3 if identity preservation is ready first. M5 and M6 can proceed in bounded parallel chunks after their native dependencies exist; their input producers must join M4's queue cutover. M7 follows all retained and removal work.

Each milestone may contain several focused, runnable commits. For each replacement, identify the native owner, the retained user behavior, the old code/storage to remove, generated-contract/caller changes and the behavior evidence. Delete superseded ownership with the cutover instead of leaving a fallback engine. Temporary sequencing inside disposable development instances is not a permanent dual-write or compatibility design.

Update this plan and the [index](index.md) as work starts or completes. Historical completed plans remain historical records; this plan governs the redesign where their ownership or product semantics conflict. Unrelated active plans are not implicitly completed or expanded by this work.

## M1 — Fresh runtime and executable/schema baseline

**Work**

- Introduce a fresh instance root, with a proposed default of `~/.kodex/native-v1/`, containing `codex-home/`, the new gateway database and an instance identity. Existing path overrides must select a fresh or recognized new instance; they must not silently adopt legacy storage. Refuse unsafe aliases/overlap before writing. Namespace instance-bound browser references by the new identity.
- Explicitly set the chosen native home for every Kodex-managed Codex launch. Sanitize storage redirects such as inherited `CODEX_SQLITE_HOME` and effective `sqlite_home`; ensure native config, credential storage, plugins/caches, queue and databases stay in the chosen scope. Check project/config-layer overrides as well as the parent environment. Manage only Kodex-owned processes.
- Use native sign-in and fresh configuration. Remove ambient Codex-auth overrides, including `CODEX_ACCESS_TOKEN` and `CODEX_API_KEY`, from managed launches; allow provider credentials only through deliberate new-instance configuration rather than silently importing parent-process auth. Do not copy desktop credentials or introduce desktop endpoint discovery. Document that project worktrees/configuration, ambient skill discovery and same-account quotas can still be shared.
- Pin a separately configured executable to 0.160.0. Update schema generation to invoke that executable and verify its version rather than allowing a version label to describe schemas generated by a different `PATH` binary. Regenerate experimental schemas, adapter contracts and affected OpenAPI/frontend artifacts.
- Remove obsolete history flags/probing; update history parameters, model/effort handling, MCP auth values, supported items/errors and callbacks against the exact schema. Advertise only implemented capabilities; unsupported server requests receive an explicit protocol error. Do not enable external-clock verification accidentally.
- Add the minimum native project creation/ID forwarding needed for an ordinary project/thread/turn smoke test. Full project-registry removal follows in M2.
- Remove title inference jobs, hardcoded auxiliary `codex exec` launch, retries and generation-specific tests. Keep native manual naming and preview fallback.
- Preserve sandbox-readable upload paths; moving runtime state must not make submitted images/files inaccessible to app-server tools.

**Delete/replace:** inherited-home launch defaults, obsolete validator assumptions and fake compatibility probes, title-generation subsystem; replace the fresh schema bootstrap as old tables lose their owners in subsequent milestones. Do not run the legacy migration chain against old data.

**Exit:** wrong executable versions fail clearly; a disposable instance can sign in/configure, create a native project and chat, run a turn, display/respond to an approval, Stop and reopen. Isolation fixtures cover inherited storage/auth overrides (including a synthetic `CODEX_ACCESS_TOKEN`), symlink aliases, auxiliary launches and plugin/config paths while sentinel legacy files remain untouched. Browser references from the old instance do not select or replay old work. Uploads remain usable under the supported native sandbox.

## M2 — Native projects, settings, organization and requests

**Work**

- Replace gateway project UUIDs/registry and cwd-derived associations with native project APIs, IDs, assignment and order. New retained records reference those IDs directly.
- Use native sections and ordering. Keep small gateway invalidation/refetch plumbing where native section notifications are absent; verify reconnect behavior. Do not reproduce desktop's private sidebar state or use unsupported local `originators` filtering as ownership enforcement.
- Complete the removal of existing-thread settings overlays. Explicit picker changes patch shared native settings; ordinary input omits model/effort/service-tier/defaults rather than sending a stale full options object. Separate active-turn settings from settings for future execution. New-thread choices are creation data; unsent drafts remain local.
- Replace durable native-approval authority with a runtime/connection-scoped mirror of outstanding server requests, replay and `serverRequest/resolved`. Scope reused request IDs by runtime generation and invalidate stale responses. Preserve distinct Kodex-local approvals/grants for retained MCP App operations.
- Use native config layer identity and version checks for sparse writes. On conflict, reread and require the user to review the conflicting change; do not overwrite unrelated fields. Preserve unknown MCP policy/config keys and masked secrets. Respect native reload limits for session-static settings.
- Reconcile contributor guidance with native ownership: gateway routing/projection does not require a second gateway durable owner. Replace the old per-row-options rule when its implementation changes. Preserve canonical rendering, stale-safe Stop, settings conflict and two-client guarantees.

**Delete/replace:** project registry/mapping logic, overlapping pin/order stores, existing-thread setting fallback stores and full-object overlays, stale native-approval persistence/recovery, destructive config reconstruction. Retain only data for genuinely Kodex-owned extensions.

**Exit:** two clients converge after project/section/settings/config changes and missed events. Disjoint settings edits survive; stale full forms cannot reset newer values; active and next-turn settings are correctly displayed. Reused native request IDs cannot revive or answer stale approvals. Fresh automation/project references use native IDs. No old project associations are imported.

## M3 — Native history, identity, discovery and skill selection

**Work**

- Preserve `clientUserMessageId`/native user-message `clientId` end to end, including generated DTOs, native history pages, pending submission correlation and canonical live events. Repeated identical text is distinct input. Identity is evidence for reconciliation, not a promise that retrying the same ID is idempotent.
- Use native paged turn/item history and resume initial pages to reduce redundant attach/hydration reads. Keep one bounded, disposable gateway render projection with ordered snapshots/patches, runtime/sequence protection and refetch on uncertainty. Preserve supported presentation grouping and long-history pagination.
- Replace loaded-list fan-out and recursive subagent guesses with native ancestry/descendant filters and input capability. Include unloaded descendants and respect read-only/internal children.
- Remove raw `$skill` scanning, injected selections and strict missing-selection rejection. Let native parsing own free text; retain native catalog autocomplete and explicit structured selections. Keep supplied display metadata where useful without a second skill-resolution engine.
- Keep shared read/unread state for retained badges, based on authoritative native completion identity and gateway reconciliation. Eliminate full-history counting on ordinary page loads where possible. Choose and test the minimal read-marker design before removing old counters; a single tab's observed events cannot become the durable source.

**Delete/replace:** text/FIFO user-message matching, redundant history overlays/hydration, subagent scans, custom free-text skill resolver, unnecessary historical counting. Do not remove the bounded live projection or replace it with raw browser lifecycle interpretation.

**Exit:** live streaming, initial/older pages, completion, interruption, fork/revert, duplicate text, two tabs, missed SSE and native restart converge without duplicate rows or overwritten live content. Client IDs survive both snapshots and streaming paths. Subagent browsing is bounded and prohibited child input is unavailable. Read/badge state converges after an offline client returns. No legacy history converter is introduced.

## M4 — Native input and queues, with narrow promotion recovery

**Work**

- Delegate “send now” to native atomic start-or-steer and explicit active-turn steering to its native contract. Preserve a separate “queue for later” intent. The gateway still resolves current-turn Stop; the browser does not select a turn from stale state. Simplify unsupported/not-steerable outcomes into clear recoverable UI instead of rebuilding a general routing/retry engine.
- Replace ordinary queue CRUD, reorder, manual start, persistence and dispatch with native queue APIs. Refetch on native queue invalidation. Expose native restrictions and pause-after-interrupt behavior; do not silently fall back to a custom queue for unsupported threads.
- Use the selected native restart behavior: durable queues dispatch only for loaded eligible threads. Ordinary queued work waits until its chat is opened/loaded after app-server restart. Do not maintain an ordinary-queue startup activation index, scan native databases or retain a global drainer to conceal the native loading requirement. Automations load their targets without a browser and reconcile/reactivate outstanding admissions from their own run records.
- Drop frozen per-row execution settings and local next-send overlays. Explain that queued messages use the thread settings in effect at execution. Native `thread/queue/start` starts eligible idle work; it does not inject into an active turn.
- Move **every producer**—composer, automations and Kodex Control—to shared native submission handlers before deleting the custom drainer. Keep schedule/run policy, fixed-interval recurrence, pause/delete/run-now behavior, concurrency and missed-interval handling. Keep only submission correlation/source metadata required for run admission and notification policy; this must not become a second queue payload store or scheduler. A queued run is not yet completed inference.
- Keep queued-row “Steer” through a small durable transfer record: save recoverable input, native queue/client IDs, intended turn and phase; serialize all Kodex mutations of that row; confirm deletion before steering; retain the record until native delivery evidence settles the outcome. App-server owns steering timing.
- A confirmed `deleted: false` does not permit sending. A lost delete acknowledgment or missing queue row is ambiguous. Even confirmed deletion needs delivery reconciliation after dispatch/restart uncertainty: native dispatch can accept input before removing its row. Persist confirmed deletion before steering, and distinguish acknowledgment/acceptance from committed user-message evidence.
- On definitive rejection, expose saved content for recovery, with restore-to-composer as the simplest action. On uncertainty, reconcile and display pending/uncertain state; never blindly resend, requeue, start a replacement turn or infer non-delivery only from absent history. State the single-gateway mutation assumption; UI and Control use the same coordination paths.

**Delete/replace:** ordinary queued-input table/API model, custom drainer/claims, broad queue recovery and pending-commit engine, option-bearing rows and routing retries. Preserve only the bounded transfer and retained producer bookkeeping justified above; no legacy queue conversion or replay.

**Exit:** queue CRUD/order/start and native dispatch work across two clients; interruption pauses correctly; all producers share the new path. After native/gateway restart with no chat activation, ordinary queued messages remain stored without Kodex reactivating their chats; loading an eligible chat enables native dispatch. Test unattended automation-target activation separately. Automation ticks/restarts and uncertain admissions do not blindly submit duplicates. Promotion fault tests cover each persisted boundary, competing row edits, dispatch/delete races, already-delivered rows with failed native cleanup, lost delete/steer acknowledgments, accepted-but-uncommitted input, turn end and gateway/native restart. Every case yields a visible, convergent outcome or recoverable uncertainty; no exactly-once claim is made from client IDs alone.

## M5 — MCP setup, interactive apps and Kodex Control

**Work**

- Keep browser MCP setup/status/auth, plugin installation and sparse native config editing from M2. Preserve native unknown fields, capability/error data and resource/account identity.
- Use originating call/account metadata and native `mcpAppUi` for interactive app discovery. Retain a bounded fallback for widgets exposed only through tool-result metadata; this is a supported fresh-result path, not a legacy-storage reader.
- Keep the iframe host, CSP/permissions, grants, bridge routing, generated app revisions and UI. Preserve explicit approval for generated-provider tool execution and the provenance of tool/resource requests.
- Retain the external plugin/MCP interface and supported callers. Share handlers with UI/native delegates for projects, threads, automations and app surfaces; native dynamic tools alone do not replace that interface.
- Require external callers to explicitly target a Kodex-owned thread. A foreign `_meta.threadId` must not trigger resume/import from another native home. Keep usable required tool schemas, caller guards and supported discovery/wait operations. Coordinate native input/queue changes with M4.
- Update plugin copy, schemas, callers and the plugin cachebuster together; install/test into the disposable Kodex home.

**Delete/replace:** duplicate discovery/parsing where native metadata suffices, duplicated execution handlers, implicit foreign-thread defaulting and any direct native SQLite/rollout mutation still reachable from ordinary workflows. Preview-only Control removal is part of M6.

**Exit:** two clients can configure/authenticate MCP servers without lost config fields, and render/reopen external and generated app surfaces. Tool/resource calls retain account/thread scope; unauthorized bridge operations remain rejected. UI and external MCP callers complete retained thread/automation/surface workflows through the same native delegates. No caller gains a shared-desktop-state path.

## M6 — Retained browser/host features and feature removals

**Work**

- Keep the terminal's gateway-owned PTY supervision, bounded reconnect buffer, interactive input, resize and termination. Browser disconnect and app-server restart do not end it. Preserve the existing gateway-lifetime boundary and host-shell permissions; do not add detached terminal persistence. Ensure gateway-managed shell launch defaults do not accidentally reintroduce the desktop native home.
- Keep docking and mobile single-pane presentation, including duplicate chat panes, app surfaces and terminals. Namespace persisted references by fresh instance identity; layout, focus and drafts stay browser-local. Pane closure must not implicitly cancel execution.
- Preserve PWA installation/manifest, static-only cache, waiting-worker update prompt, device subscription reconciliation, test diagnostics, per-thread preferences, durable bounded notification delivery/retries, source/foreground suppression, click-to-thread routing and unread badges. Keep notification policy separate from unread state; unread supplies badges. Do not add an offline transcript or execution subsystem.
- Remove remote-preview registry, routes, fresh-schema tables, configuration knobs, public-port allocation, Caddy supervision and UI. Remove preview-only Control endpoints/tools/resources, `kodex-proxy-evaluation`, and preview-oriented plugin copy. Keep the MCP entrypoint, generated-app skill and retained control operations.
- Preserve operator-managed HTTPS for Kodex's private-network PWA deployment. Kodex's removed preview Caddy serves HTTP and is not that HTTPS endpoint; do not replace it with a new certificate/proxy manager.

**Delete/replace:** all remote development-preview machinery and its exclusive dependencies/tests. Keep `portable-pty` or the equivalent maintained terminal backend because independent terminal lifetime is now an explicit requirement. Simplify retained implementations when behavior coverage supports it.

**Exit:** no remote-preview capability remains in HTTP/OpenAPI/MCP/UI or startup requirements. File previews, uploads, generated surfaces and plugin setup still work. Terminal interaction survives app-server restart and browser reconnect; gateway restart/exit is handled honestly. Two tabs and duplicate panes converge; desktop fine pointer, narrow fine pointer and narrow touch flows remain usable. Secure-context PWA install/update/Push/badge/click flows pass, with graceful handling of unavailable browser APIs.

The remote-preview removal can be an early independent slice after M1; coordinate plugin and generated-contract edits with M5 rather than keeping dead code until the end.

## M7 — Integrated verification and fresh release readiness

- Run the relevant backend, frontend and contract suites, frontend build/typecheck and both trim scripts. Regenerate OpenAPI/frontend artifacts and verify they match the retained API. Run same-user two-client and real-browser checks for shared state and responsive flows. Follow the repository's independent review gate for each implementation chunk and for the integrated result.
- Exercise a disposable real 0.160.0 app-server as well as mocks. Include startup/version rejection, native projects/settings/config, history and streaming, queue dispatch/promotion failures, approvals, fresh sign-in, MCP Apps/Control and dedicated-home isolation. Mocks alone do not establish lifecycle compatibility.
- Use existing long-thread and multi-pane fixtures to compare responsiveness, event traffic and initial history reads with the current baseline. Keep rendering/bandwidth guardrails; investigate observed regressions rather than imposing arbitrary code-size or latency targets.
- Inventory surviving tables, workers, retries and caches. Each must have an owner and a retained user need. Remove dead modules, obsolete tests, dependencies and old bootstrap definitions from the new schema. No second ordinary queue, project/settings authority, transcript store or desktop-storage repair path may remain.
- Update README, deployment/configuration documentation, AGENTS, plugin guidance and plan statuses to describe the actual result. Replace old setup commands/default paths and explicitly document fresh sign-in/setup, separate homes, terminal lifetime and local/VPN-only access.
- Prepare the fresh launch procedure: stop only the retired Kodex instance so its old scheduler/drainer is not left running, start the validated build with empty new stores, sign in and configure new projects/MCP/schedules deliberately. Verify old storage remains unchanged. Restoring an old deployment is a separate operational choice, not data interchange between the two instances.
- Do not treat this plan request as authorization to restart production now. Actual deployment follows the existing production-restart workflow when requested; until then the gate produces a tested build and documented launch procedure.

**Exit:** all milestone checks pass, meaningful independent review findings are resolved, generated contracts/docs are current, obsolete ownership is deleted and the replacement is ready for a deliberate fresh launch. Record actual verification and any environment limitations; do not mark release readiness complete with unmet behavior gates.

## Remaining engineering proofs and explicit limits

| Gap to settle during implementation | Required result |
| --- | --- |
| Experimental queue/project/section/history APIs | Pin the exact binary/schema and exercise supported behavior. Version mismatch is a clear failure, not a permissive fallback to the old implementation. |
| No atomic queue-to-steer operation or blanket submission idempotency | Validate the narrow coordinator and native identity evidence. Keep ambiguous input visible and recoverable; if a failure cannot be safely distinguished, do not automate a retry. Revisit deletion of this coordinator if upstream adds a suitable primitive. |
| Queued storage persists but dispatch requires a loaded thread | Native behavior is selected: ordinary queued work waits until its chat is loaded. No general startup activation bookkeeping. Automations activate their own targets without browser participation; queue payload/order/dispatch remain native. |
| Native section notifications and live-event replay are incomplete for browser convergence | Keep bounded gateway invalidation/runtime sequencing and reconnect snapshots. Do not add a duplicate durable native store to cover the gap. |
| No native read/unread or web Push service | Choose a small shared read-marker design and retain necessary delivery records; prove missed-event/two-client convergence and keep Push policy separate. |
| Native MCP metadata does not cover every widget | Prove native discovery plus result-metadata fallback with scoped resource calls and generated-app approval behavior. |
| Dedicated home does not isolate project files, ambient skills or every config redirect | Enforce Kodex storage ownership and document the remaining shared filesystem/discovery boundary. Do not build a new workspace sandbox or desktop credential bridge. |

The queue-restart, terminal-lifetime and automatic-title questions are resolved above. There is no remaining migration or desktop-integration decision. Settings/sidebar simplifications follow the general native-first direction; remaining work is to prove the implementation preserves the retained workflows and correctness guarantees, not to reopen native defaults individually.

New native UI features—such as goals, broader search/revert controls, richer attachments, additional usage views or voice—can be evaluated after the ownership reduction. Do not add them to this redesign merely because an RPC now exists. Existing supported flows still require correct handling of the newer native contract.
