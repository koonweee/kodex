# App-server native capability and desktop coexistence audit

Date: 2026-10-04. Scope: architectural audit and implementation recommendations; no runtime upgrade or application behavior changes.

Implementation follow-through is defined in the [native app-server redesign plan](../../plans/native-app-server-redesign.md). It incorporates the later terminal/title decisions, milestone dependencies and acceptance gates; this audit remains the supporting capability evidence.

## Decision

Kodex can relinquish substantial ownership to app-server. The best targets are the durable input queue, user-message reconciliation, project records, subagent discovery, approval lifecycle reconciliation and raw skill resolution. Native host execution is also available, but the later decision to retain app-server-independent terminals requires keeping Kodex's terminal supervisor. Some of these primitives are new; others were already available in Kodex's pinned version but were not adopted.

The desired boundary is **app-server owns Codex execution and durable Codex state; Kodex adapts that state for a responsive browser and owns only justified additional host/browser features**. Missing native support does not establish a feature requirement. Prefer changing or dropping a convenience feature over rebuilding an execution subsystem to preserve it. Keep one bounded, disposable snapshot/live projection for browser convergence; a history API does not provide a resumable live event log.

**Subsystem replacement is welcome when it produces a simpler design.** Start from the retained user workflows and current native contract, then choose whether to adapt or replace the existing implementation. Keeping a feature does not require keeping its modules, tables, state machines, internal API shape or implementation-specific tests. Remove superseded machinery and dependencies with the replacement, update contracts/callers together, and preserve meaningful behavior tests. Judge simplicity by the state and lifecycle rules Kodex must own as well as code size. Scoped, reviewable work can replace an entire subsystem; it need not accumulate patches around the old design or preserve a permanent compatibility layer.

The chosen ownership target is **a dedicated Kodex `CODEX_HOME` and a Kodex-owned app-server process**. Sharing desktop's home or live runtime is outside this redesign's scope. Today's inherited-home default does not implement that isolation. Resolve this and version compatibility before pursuing the larger deletions.

**Start fresh; do not implement legacy data migration.** Use new native state and new gateway state, with fresh client state for references into that instance. Existing history, projects, queued work, schedules, settings and credentials are not imported or replayed. This removes old-to-new ID maps, queue conversion, backfills, compatibility readers and dual-write transition work. Leave old storage intact and outside the new runtime; this decision does not require deleting it. Initializing the new schema and keeping newly created work correct remain necessary.

**Retain automations, MCP Apps, MCP setup, Kodex Control tools, docking and PWA extras. Remove remote development-server previews.** These product decisions settle whether the listed features belong in Kodex. Their internal ownership can still shrink through native primitives. Removing remote previews includes Caddy routing/supervision and preview-specific tools/skills, not file previews or generated app surfaces. Ordinary Kodex access over a trusted VPN remains in scope.

**Retain the integrated terminal with independent process supervision; remove automatic AI-generated titles.** The terminal remains gateway-owned and survives app-server connection loss/restart; this does not add survival across gateway restarts. Native preview text and manual names replace title inference. These later choices supersede the earlier recommendation to adopt native terminal lifetime and settle the title question.

The recommendations below favor native queue settings and retain queued-row promotion as a justified, narrow extension: users can change their mind about waiting and send an existing queued message into the active turn without retyping it. Native steering determines when that input is incorporated; Kodex does not need custom immediate interruption. These are architectural recommendations, not implemented changes. The user's direction to justify all extra logic applies equally to existing features and new ones.

## Evidence and limits

| Surface | Observed baseline |
| --- | --- |
| Kodex checkout | `00424e9`, clean at audit start; latest commit dated 2026-08-17 |
| Kodex compiled request validator | `0.135.0`, including experimental APIs; [schema.rs](../../apps/gateway/src/schema.rs#L7) |
| CLI resolved from `PATH` | `/Users/jtkw/.local/bin/codex`, `codex-cli 0.157.1` |
| Installed desktop bundle | `/Applications/ChatGPT.app`, bundle ID `com.openai.codex`, app version `26.930.31730`, build `12947` |
| Desktop bundled CLI | `codex-cli 0.160.0` |
| Latest public stable release retrieved | [`rust-v0.160.0`](https://github.com/openai/codex/releases/tag/rust-v0.160.0), published 2026-10-01 |
| Upstream main inspected separately | [`d0759639f20af955a5c6447f4683e99bf42ab6cf`](https://github.com/openai/codex/tree/d0759639f20af955a5c6447f4683e99bf42ab6cf) |

The audit examined repository implementation and plans; generated schemas from the installed CLI and desktop binary; the release's generated experimental schema, request processors, persistence, transport, and relevant upstream tests; current public [app-server documentation](https://learn.chatgpt.com/docs/app-server); and the [release README](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server/README.md). The current source README contains supplementary notes, so it was not treated as a complete method catalog.

The **440 JSON schema files generated by the desktop's 0.160.0 binary match the release's experimental schema exactly**, after parsing JSON. The full experimental client method inventory grows from 108 in Kodex's baseline to 167 in 0.160.0: 61 added, two removed. Server notifications grow from 64 to 83; server requests from 10 to 11. The installed 0.157.1 has the same method names as 0.160.0, which does **not** establish field or behavioral equivalence. Upstream's ordinary checked-in `schema/json` omits experimental client methods; comparing only that directory would give misleading removals.

In this report, “released” means present in the 0.160.0 release. “Experimental” is a separate protocol stability qualification. Several of the most useful released APIs still require `experimentalApi`. Kodex already opts in, but adopting them still requires version pinning and behavioral tests.

No live user threads were resumed, no inference turns were run, and no account, config, desktop database, daemon, or production service was changed. Process inspection was unavailable in the sandbox; the binary, arguments and home of running Kodex and desktop app-server processes remain unverified. The version table establishes installed versions only. Desktop endpoint compatibility was not established and is no longer an implementation objective. Temporary source/schema evidence was collected under `/tmp/kodex-app-server-audit-20261004`.

## Upgrade blockers and correctness risks

### 1. Kodex project IDs now collide with a real native field

Kodex creates projects in its own SQLite database and forwards that ID as `thread/start.projectId`. In 0.135.0 this was not a declared native start field. In 0.160.0 it identifies an existing app-server project, and the server explicitly returns `project not found` for an unknown ID. An ordinary gateway project UUID cannot be forwarded as a native ID.

Evidence: Kodex project store at audit revision `0362c9a` (`apps/gateway/src/store/projects.rs:16`, removed by the redesign), [start payload](../../apps/gateway/src/app_server_api/client.rs#L94), [upstream validation](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server/src/request_processors/thread_processor.rs#L1180).

**Action:** create projects natively in the fresh instance and pass native IDs throughout new thread/automation records. Omit `projectId` until a valid native project exists. No import or old-to-new ID map is needed; do not reinterpret old local IDs or infer membership solely from a matching working directory.

### 2. The old validator is no longer a compatibility guarantee

Kodex's schema still requires/supports its `persistExtendedHistory` convention and probes that field using a nonexistent thread. The current contract removes that field from start/resume/fork and introduces a persisted `historyMode` plus richer paginated history. An unknown field being ignored, or a probe returning “thread missing,” does not establish the required history behavior.

The old schema also models reasoning effort as a closed enum ending at `xhigh`; the new contract uses a string. Kodex's model picker can discover a new effort from the catalog and still have the old outbound validator reject it. Native `McpAuthStatus` now includes `unknown`, but Kodex's Rust enum does not, so an otherwise valid MCP status response can fail deserialization.

`thread/rollback` and `thread/turns/items/list` were removed from the full method inventory, replaced by the newer revert/item history surfaces. Kodex's current wrappers do not appear to call those removed methods, so these are upgrade inventory items rather than demonstrated current call-site failures.

Server callbacks also need explicit dispatch. The new experimental `currentTime/read` is used only with an externally configured clock, not the default system clock. Kodex currently warns and returns without an RPC response for unsupported server requests. A compatibility pass should handle negotiated callbacks or reject unsupported ones promptly; enabling experimental APIs does not implement every callback.

Evidence: [compatibility probe](../../apps/gateway/src/app_server.rs#L140), [old schema](../../apps/gateway/app-server-schema/0.135.0/json/ClientRequest.json), [MCP enum](../../apps/gateway/src/app_server_api/mod.rs#L227), [unsupported callbacks](../../apps/gateway/src/events.rs#L271), [current start/history contract](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L62), [current reasoning-effort type](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/protocol/src/openai_models.rs), [external clock selection](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/core/src/current_time.rs#L43).

**Action:** pin a tested executable and regenerate the experimental contract together; update response handling and generated OpenAPI types; replace the obsolete startup probe with meaningful, isolated contract tests. Do not point production at an auto-updated desktop executable and assume future updates remain compatible.

### 3. Persisted approval rows are not durable upstream requests

Kodex persists approval requests with gateway UUIDs and raw upstream request IDs. Upstream requests belong to a runtime/connection lifecycle; request IDs may be reused after restart. Native `serverRequest/resolved` already existed in the old contract, but Kodex does not consume it. A resolution elsewhere or replay on attach can therefore leave a stale or duplicate gateway approval.

Evidence: [approval insertion](../../apps/gateway/src/store/approvals.rs#L11), [upstream response forwarding](../../apps/gateway/src/app_server.rs#L336), [upstream request ownership and resolution](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server/src/outgoing_message.rs).

**Action:** treat approval state as a runtime-scoped mirror. Reconcile replayed requests, consume native resolution, deduplicate with runtime identity, and invalidate stale actionable rows on disconnect/restart. Retain local audit history separately if useful. Never send a persisted old request ID into a newly launched process as if it were still pending.

### 4. Configuration writes need native concurrency controls

The gateway's `config/batchWrite` helper uses `reloadUserConfig: true` without `filePath` or `expectedVersion`. MCP replacement also reads effective layered config and writes reconstructed configuration. The current shared home permits conflicts with desktop edits and copying inherited settings into the user layer. A dedicated home removes the desktop writer, but versioned layer-specific writes still protect against concurrent Kodex tabs or manual edits.

There is a concrete preservation problem even without a concurrent edit: `mcp_replace_server` rebuilds a whitelisted server object and writes it with `mergeStrategy: "replace"`. Native fields such as `default_tools_approval_mode`, `disabled_tools`, `oauth`, and per-tool `tools` can be discarded when the UI edits an unrelated field. Prefer sparse leaf edits, or preserve the complete object from the intended writable layer under a version check.

Native configuration already exposes layer provenance, version tokens, and conflict-checked writes. The current contract explicitly excludes session-static model, reasoning effort, Plan reasoning effort, and service tier from blanket live reload. Historical plan wording about hot refresh should not be used as a current behavioral promise.

Evidence: [Kodex batch write](../../apps/gateway/src/app_server_api/client.rs#L670), [MCP replacement](../../apps/gateway/src/app_server_api/client.rs#L591), [MCP object reconstruction](../../apps/gateway/src/app_server_api/mod.rs#L504), [native MCP policy fields](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/config/src/mcp_types.rs#L288), [native config contract](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server-protocol/src/protocol/v2/config.rs#L1086).

**Action:** write the intended layer with its expected version and handle conflicts by rereading. Keep default configuration changes distinct from existing-thread settings and active-turn settings.

### 5. Hosted MCP resources require originating call/account scope

Kodex currently reads MCP resources using server, thread, and URI. New native reads can carry `originCallId`, `connectorId`, or a direct `{connectorId, linkId}` target. Hosted app resources can be account-specific; rediscovering a catalog and reissuing an unscoped URI read is not equivalent to following the originating tool call.

**Action:** preserve the native tool-call/account provenance through resource and app-surface operations. Do not invent account targets, treat missing account identity as anonymous, or collapse multiple linked accounts into one server-name lookup. Native `mcpAppUi` also carries resource/display metadata through live events and saved history, reducing catalog rediscovery. The fresh start removes legacy-home history compatibility work, but newly produced result-metadata-only widgets can still lack that field; retain the fallback discovery needed for those interactive flows.

Use thread/server-scoped MCP status reads instead of rediscovering all configured servers for an app-surface grant. Expose native `runtimeStatus`, capability/provenance metadata and discovery errors, which the current compact DTO discards, instead of inferring readiness from installation or an empty tool list.

Evidence: [current resource client](../../apps/gateway/src/app_server_api/client.rs), [app-surface backend](../../apps/gateway/src/app_surfaces.rs), [native MCP contract](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server-protocol/src/protocol/v2/mcp.rs), [hosted-resource and UI notes](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server/README.md#hosted-resource-reads).

## Ownership reduction map

| Kodex responsibility | Native alternative and maturity | Recommendation and remaining boundary |
| --- | --- | --- |
| SQLite queued inputs, drainer, update/delete/reorder/start | **New, experimental:** `thread/queue/add`, `list`, `update`, `delete`, `reorder`, `start`, `thread/queue/changed`; durable native store and idle dispatch | **High-priority replacement.** Adopt native storage/dispatch and drop per-row settings. Retain only a bounded transfer coordinator for the justified queued-row steering action described below. |
| Send-versus-steer state machine | Native `turn/start` performs atomic start-or-steer; `turn/steer` retains an explicit expected-turn check | Delegate execution routing. Preserve the UI's distinction between “send now,” explicit steer, and “queue for later.” |
| Pending-input exact-text/FIFO matching | **New fields:** `clientUserMessageId` and echoed `userMessage.clientId` | Replace content-based reconciliation with stable identities. Resolve uncertain submissions against native state before retrying; the ID alone is not a blanket exactly-once guarantee. |
| Transcript history and attach fan-out | Native `thread/turns/list`, **new** `thread/items/list`, backwards cursors; experimental resume `initialTurnsPage` and start `historyMode` | Use native pages and identity/order. Remove redundant hydration and history reconstruction. Keep a bounded live render projection and reconnect recovery. |
| Combined ordinary/voice history | **New, experimental:** `thread/timeline/list`, canonical rollout positions and realtime boundaries | Useful if voice is adopted. It is not a drop-in replacement for Kodex's live row-patch protocol. |
| Subagent graph, loaded-list scans, recursive source parsing | **New:** `parentThreadId`; native `sessionId`; experimental descendant filters and `canAcceptDirectInput` | Replace loaded-list-plus-N-reads discovery with native filtered lists. Honor direct-input capability instead of treating every child as an ordinary writable chat. |
| Thread settings overlays | Already adopted: `thread/settings/update`, `thread/settings/updated`, native permission profiles; **new** summary model/effort readback and active-turn settings | Complete removal of existing-thread fallback authority once native readback covers each consumer. Keep unsent per-pane drafts local. |
| Gateway project registry and cwd-derived membership | **New, experimental:** `project/*`, native project assignment, change notifications, ordering and recency | Create native projects in the fresh instance. New automation references use native IDs; remove remote-preview references rather than migrate either old registry. |
| Pins and sidebar order | **New, non-experimental RPCs:** `threadSection/*`, `thread/section/move`, `section_position`, `recency_at` | Prefer one native section per thread and native order. Drop independent project-local pinning and attention-first sorting unless a specific navigation need justifies another authority. |
| Approval persistence and reconciliation | Existing native request replay and `serverRequest/resolved` | Keep a thin presentation/broker mirror, remove independent pending-request authority. |
| `portable-pty` execution/process lifecycle | Already available: `command/exec` with TTY/write/resize/terminate; experimental `process/*` for unsandboxed processes | **Retain independent terminal supervision by user decision.** Native handles end with the app-server connection, which does not meet the retained lifetime. Keep the terminal UI and bounded reconnect buffer; do not add gateway-restart durability. |
| Raw `$skill` discovery and injection | Native skill selection handles structured inputs, linked/plain mentions, disabled skills and ambiguity | Remove raw-text rewriting. Keep explicit autocomplete; restrict display enrichment to available native/explicit-selection metadata. |
| MCP installation/config parsing | Many native calls already adopted; `config` versioning, scoped status/resource reads, plugin reconciliation | **Retain browser MCP setup.** Use native plugin/auth/status/config lifecycle and sparse versioned edits; minimize duplicated config parsing/models. |
| MCP Apps rendering/bridge | Existing native tools/resources; new `mcpAppUi`, originating-call scope, server event streams and capability metadata | **Retain interactive apps.** Reduce catalog/metadata reconstruction and keep the iframe host, required bridge, permissions and surface UX. |
| File previews and uploads | Existing `fs/*` APIs; image/audio inputs; native thread resource attachments | `fs/*` helps a remote-runtime adapter, but browser uploads, preview HTTP/MIME handling and host access policy remain. Resource attachments are not file-byte upload or generic document input. |
| Automatic thread titles | `thread/name/set` is native; no dedicated title-generation RPC found | **Remove generation by user decision.** Use native preview/manual names and delete inference jobs, retries and the auxiliary subprocess. |
| Recurring automations | Existing native goals provide event-driven continuation within a thread, not a calendar scheduler | **Retain schedules, run records and notification policy.** Native queues execute scheduled input; goals complement rather than replace calendar scheduling. Start with no imported schedules. |
| Read receipts, attention ordering and PWA notifications | No equivalent local app-server read-receipt/push subscription contract found | **Retain PWA notification/badge workflows and the shared read state they require.** Simplify counters and sorting only where those workflows remain correct; attention-first ordering remains a separate product choice. |
| Caddy previews, PWA, Dockview/mobile shell | No app-server equivalent | **Remove remote preview proxy machinery; retain docking and PWA extras.** Keep browser-local layout ownership and responsive mobile access. |
| Kodex Control tools | Native RPCs plus Kodex-only host features | **Retain the tool surface and its supported callers**, except preview-specific operations removed with remote previews. Delegate native actions; share host handlers. Intentional tool access does not imply sharing desktop's native home/runtime. |

### Native queue ownership with a narrow queued-row steering action

The native queue stores rows with `id`, `input` and `clientUserMessageId`, and supports ordering and manual start. The dispatcher supplies the `queue` trigger; trigger metadata is not a general per-row field. It does **not** carry Kodex's full queued per-row model/effort/options object, and it has no atomic “remove this queued row and steer it into the running turn” operation. Automatic draining also treats interruption differently from an ordinary successful completion.

**Per-row settings** remember the options submitted with each waiting message. For example, one message can be queued with a cheaper model/low effort and a later message with a stronger model/high effort; each row keeps its choice even if thread settings change before execution. Kodex serializes that options object and passes it to `turn/start` when draining. This preserves the earlier pane-composer “next send” behavior, but is not required to queue work. **Recommendation: drop frozen per-row options.** Use the native thread settings in effect when the queued message starts, and make that behavior clear in the queue UI. A mixed-model batch workflow would be a reason to reconsider, but no such requirement has been established here. Native explicit steering already ignores these queued options.

**Queued-row promotion into the active turn** is the existing queued message's `Steer` button: “I wrote this for later; apply it to the current work instead.” Kodex currently claims the row, sends `turn/steer`, leaves it in `pendingCommit`, matches the committed message, and recovers uncommitted rows on interruption. **Revised recommendation: retain this action.** The user has identified moving existing queued input into current work as a useful workflow. Re-entering the message through ordinary steering is a worse interaction, so some coordination is justified. It does not justify retaining the entire gateway queue engine or frozen per-row options.

Timing is a separate question. `thread/queue/start` requires the whole thread to be idle; during an active turn it returns an error and preserves the queued row. It does not mean “insert after the next tool call.” Native `turn/steer` accepts pending input for the active turn and owns its incorporation timing, including tool-drain handling. Use that behavior; do not introduce a Kodex interrupt/restart sequence or promise an exact next-tool-call boundary.

The smallest candidate keeps native storage and dispatch for ordinary queued work, with a durable gateway record only while transferring a selected row:

1. Serialize Kodex edits/deletes/promotions of that row and persist the payload, native queue ID, client message ID, intended turn and operation phase before removing it. That record preserves recoverable input across a gateway crash; it is not a second scheduler.
2. Call native queue deletion first and persist confirmed deletion before requesting steering. A confirmed `deleted: true` is necessary to proceed; native deletion shares the queue dispatch lock, preventing ordinary concurrent dispatch of the same row. It is not sufficient evidence after a prior dispatch/restart uncertainty: native dispatch starts input before deleting its row, so a crash or failed cleanup can leave already-accepted input in the queue. Reconcile native delivery evidence by client ID and keep unresolved cases out of automatic promotion. If deletion returns false, the row may already have dispatched or been removed, so refresh and do not send another copy. A lost deletion acknowledgment is ambiguous: a missing row alone does not prove this operation deleted it.
3. Send the saved input through `turn/steer` with its client message ID and expected turn ID. App-server handles when it enters the running turn. A normal successful acknowledgment means accepted, not necessarily committed; reconcile native user-message identity before retiring the recovery record.
4. On a definitive rejection, keep the input visible and recoverable, with restoring its saved content to the composer as the simplest recovery action. If the intended turn ended, do not silently start a different turn or interrupt another one. On an uncertain deletion/steering outcome, reconcile against native state before any retry; absence from history alone is not proof that input was never accepted. Prefer explicit pending/uncertain/delivered/recoverable states to a hidden automatic retry or requeue loop.

This is a candidate adapter, not an atomic transfer guarantee. A gateway mutex cannot lock native dispatch or other native clients, and `clientUserMessageId` is correlation, not blanket idempotency. The intended deployment routes Kodex browser queue mutations through one gateway. Native deletion has no payload/version precondition: an external edit between payload capture and deletion could replace the content Kodex is transferring. Broader concurrent mutation would need an upstream claim/transfer primitive or a revised product guarantee, not just another gateway lock. Returning a failed transfer to the native queue also does not automatically restore its original row ID/order. Prove the bounded failure behavior before deleting the old implementation; if it needs a general durable retry engine, revisit the design instead of quietly keeping two queue authorities. A future native atomic queue-to-steer operation would let Kodex remove this coordinator.

A metadata sidecar cannot reliably impose per-row settings on native automatic dispatch, so that feature remains a removal recommendation. Start with an empty native queue; do not import, drain into the new instance, convert or replay old gateway queue rows or `pendingCommit` records. The old store stays outside the new runtime. Recovery requirements above apply to new submissions after launch. The gateway transfer record covers only the retained promotion workflow; ordering and normal dispatch remain native.

Native queue change notifications contain a thread ID, so invalidate/refetch the list instead of reconstructing queue state from the notification. Native queue rows also lack Kodex's failure/retry and pending-commit statuses. Local durable queue support depends on the state store, excludes ephemeral threads, and manual start requires a loaded eligible thread. These are acceptance conditions, not reasons to quietly reproduce the old drainer.

Restart activation is a separate limitation: native queue polling discovers changes only for loaded threads, and resume registers a thread for discovery. Durable rows alone do not reactivate an unloaded chat after app-server restart. **The user selected native loading semantics:** ordinary queued work waits until its chat is loaded again, with no additional startup activation index or old Kodex drainer. Retained automations still activate their own targets without a browser. This follows the broader direction to accept simple native behavior wherever possible while preserving explicitly retained workflows. Evidence: [loaded-thread discovery](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/ext/queue/src/service.rs#L149), [resume registration](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/ext/queue/src/service.rs#L538), [current Kodex recovery](../../apps/gateway/src/queue.rs#L235), [automation target activation](../../apps/gateway/src/automations.rs#L61).

Native `turn/start` parameters can update settings for future turns, including when that call ultimately steers an active turn. Explicit `turn/steer` has no settings fields. Forwarding a stale browser's complete options object through `turn/start` would undo the existing stale-tab protection. Ordinary input should omit defaults; explicit thread settings use the native settings method. `turn/settings/update` is for an already-running turn and is not a universal queued per-message options replacement.

Evidence: [native queue contract](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L899), [queue deletion and dispatch coordination](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/ext/queue/src/service.rs#L335), [busy queue-start test](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server/tests/suite/v2/thread_queue.rs#L701), [steering during tool drain](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/core/tests/suite/pending_input.rs#L1290), [native turn contract](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server-protocol/src/protocol/v2/turn.rs), [queued-row steering](../../apps/gateway/src/queue.rs#L118), [queued options at dispatch](../../apps/gateway/src/queue.rs#L484), [normal composer routing](../../apps/gateway/src/routes/turns.rs#L115), [pane next-send plan](../../plans/pane-composer-next-send-settings.md), [pending-commit rationale](../../plans/gateway-pending-steer-commit.md).

### Necessity review for the remaining custom features

Use this order for every undecided feature: identify the recurring user job; try the native workflow; consider simplifying or removing the feature; only then justify the smallest custom implementation. The user's explicit keep decisions above settle the value question for those features; evaluate their implementation complexity rather than repeatedly reopening retention. Record what additional durable state, retries, synchronization, background work and tests each requires, and what native support would let Kodex delete that machinery later. Existing code and a missing upstream method alone are not evidence of user need.

| Custom feature | User need and cheaper alternative | Recommendation and limit on ownership |
| --- | --- | --- |
| Browser transport, streaming and responsive layout | A browser needs usable rendering, input and recovery from disconnection; native RPCs do not supply that UI. | **Core.** Keep a small transport adapter and bounded snapshot/live projection. Avoid durable duplicate transcript or execution authorities. |
| Approval and submitted-message reconciliation; current-turn Stop | Users must not approve stale requests, lose submitted input, duplicate work on retries, or stop a turn chosen from stale tab state. | **Core correctness.** Keep only the broker/correlation/current-turn adapter native APIs still require. Removing an optional feature never justifies weakening the remaining workflow's correctness. |
| Per-pane execution settings beyond native semantics | Convenient to prepare different model choices in two panes. Native shared thread settings and separate threads cover the main job. | **Simplify.** Keep unsent text drafts per pane; do not preserve a per-message/frozen-settings promise through hidden overlays or full stale settings submissions. |
| Queued per-row options | Mixed-model batches. Native thread settings cover the basic queue workflow. | **Drop this extension.** No custom scheduler or settings sidecar solely to preserve it. |
| Queued-row steering | Change an existing queued message from “later” to guidance for current work without retyping it; the user wants this mechanism. | **Retain a narrow coordinator.** Native queue deletion plus native steering, with shared recovery/correlation for partial failures. No duplicate ordinary queue store/drainer or custom interruption timing. |
| Read/unread state | Find unreviewed work across chats/devices and supply the retained PWA's unread badges; native status/recency does not supply that read marker. | **Keep the shared state needed for unread/badge behavior.** Simplify accounting without breaking convergence; exact historical counters and attention-based resorting are not independently established requirements. Push policy is separate from read state. |
| Background notifications | The user retains PWA extras, including existing background notifications. | **Retain.** Keep subscription reconciliation, durable delivery/retry handling, per-thread preferences, source/presence suppression and click-to-thread routing. Use native lifecycle events; do not infer notification truth from one browser's event stream. |
| Independent project pins and custom sorting | Quickly return to a small set of chats. Native sections and ordering cover that with one owner. | **Prefer native organization.** Accept one section per thread rather than preserving overlapping pin/order models. |
| Automatic title generation | Easier scanning of a busy sidebar. Native preview text plus manual rename is adequate without inference. | **Remove by user decision.** Keep preview/manual naming without title inference, retries or job lifecycle. |
| Recurring automation scheduler | The user retains recurring unattended work. Native goals solve continuation toward an outcome, not time-based recurrence. | **Retain schedule/run bookkeeping and policy.** Dispatch through native queues. Preserve the current fixed-interval recurrence scope; this decision does not add cron/RRULE features. Old schedules are not imported. |
| Integrated terminal | Manually run/debug workspace commands from a remote browser; the user explicitly retains independence from app-server lifecycle. | **Retain gateway-owned supervision.** Native connection-owned processes do not meet this lifetime. Keep bounded browser reconnect buffering and the existing gateway-lifetime limit; do not add a detached daemon. |
| File uploads and previews | Browser users, especially on mobile, need to provide local files and inspect output. Native resource attachments do not transfer browser bytes. | **Keep the narrow bridge where needed.** Upload/path/MIME/access handling is justified for supported input and preview flows; broad file management is a separate feature. |
| MCP App iframe host | The user retains interactive tool results and Kodex's generated app surfaces. | **Retain.** Use native discovery/provenance metadata where available; keep iframe isolation, bridge/grants and surface UX. Plain output remains a fallback, not the replacement product. |
| Arbitrary MCP configuration editor | The user retains browser-based server setup without host config editing. | **Retain.** Use native plugin, account/auth, status and versioned config operations, with sparse edits that preserve fields the form does not understand. Reduce duplicate parsing rather than remove setup. |
| Caddy preview routing | Reach loopback development sites from a phone or another VPN device. The user chose removal to reduce maintenance. | **Remove.** Delete remote-preview registry/routes, Caddy supervision and preview-only Control tools/skill. Preserve unrelated file previews, generated surfaces and trusted-VPN access to Kodex itself. |
| Workspace docking | The user retains side-by-side chats, terminals and app surfaces. | **Retain Dockview/pane UX and browser-local layout persistence.** Use fresh instance state so old pane references are not restored; execution/session truth stays native or in the gateway. |
| PWA shell and extras | The user retains installed/mobile app behavior and background awareness. | **Retain** manifest/standalone shell, static-asset caching, service-worker updates, notifications and badges. Do not add offline conversation execution or an offline transcript store; those are not existing PWA requirements. |
| Kodex Control/MCP sidecar | The user retains agent access to Kodex features through the existing plugin/MCP interface. | **Retain the caller interface and guards.** Native operations become delegates; host operations share handlers with the UI. Remove preview-only tools/skill. Native dynamic tools alone are not a replacement for supported external MCP callers. |
| Raw-skill badges and missing-selection rejection | Explain which skill was selected. Native parsing/selection plus basic explicit autocomplete covers the main job. | **Drop custom inference and strict validation by default.** Keep display metadata only when supplied natively or needed for an explicit selection; do not reconstruct hidden native selection for cosmetic parity. |

The fresh-start decision explicitly removes existing-data continuity from this redesign. Preserve old storage without loading it into the new instance; provide fresh sign-in/configuration, projects and schedules through retained native/UI flows. Correctness and recovery requirements apply to data created in the new instance. Do not turn the fresh start into an importer or compatibility subsystem.

Retained-feature evidence: [automation contract](../../apps/gateway/src/routes/automations.rs#L32), [Kodex Control interface](../kodex-control.md), [MCP plugin entrypoint](../../plugins/kodex-control/.mcp.json), [browser pane persistence](../../apps/web/src/workspace/paneStore.ts#L11), [PWA service worker](../../apps/web/src/sw.ts#L9), [notification policy](../../apps/gateway/src/notifications.rs#L461), [PWA update prompt](../../apps/web/src/pwa/PwaLifecycle.tsx#L25). Current push delivery uses per-thread preferences and source/foreground suppression; unread state supplies badges. Retaining PWA extras preserves both without conflating them.

### History can become smaller without losing convergence

Kodex has already stopped treating persisted gateway events as transcript history and already uses native full turn pagination. Preserve those gains. A native page supplies history, while the gateway still needs to coordinate in-flight deltas, attach, snapshots, reconnects and multiple browser consumers. `thread/timeline/list` does not expose Kodex's complete UI row aggregation or a durable event-resume cursor.

Use `initialTurnsPage` to reduce attach/hydration round trips, `thread/items/list` for item-level pagination and anchors, and native turn/item IDs and timestamps. Keep file-change grouping, Markdown rendering, work-row presentation and bounded SSE projection as presentation concerns. Do not estimate all timeline code as removable merely because an upstream method contains “timeline.”

The current adapter also scans all turn metadata to count completed turns while loading a history page. Revisit that cost when retaining Kodex read receipts; native pagination does not by itself eliminate this extra traversal. Native Stop still takes a turn ID, so a small gateway `interrupt-current` command remains justified to prevent stale browser routing.

Evidence: [native paginated contracts](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L1705), [Kodex projection](../../apps/gateway/src/thread_view_projection.rs), [Kodex snapshot normalization](../../apps/gateway/src/app_server_api/timeline.rs), [browser reducer](../../apps/web/src/timeline/reducer.ts).

### Native projects and sections in the fresh instance

Native projects support multiple roots, metadata, idempotent creation, ordering, recency and explicit thread assignment. They replace the gateway's project registry and avoid treating every thread in a cwd as belonging to the same application-defined project. Create new projects and associations natively; new automations refer to those IDs. Do not build legacy association import or an ID migration map. Remote-preview records are outside the new scope.

Native sections support one section per thread and ordering within that section. There is no dedicated native pin boolean or desktop read-state API in the inspected local contract. A “Pinned” section is a viable product convention. Prefer that simpler organization to preserving independent project-local pins or matching desktop's sidebar. Section APIs also lack a dedicated section-change notification in the inspected notification inventory, so cross-connection refresh behavior must be verified before deleting existing invalidation.

Do not use `originators` as a local-server ownership filter: the current `thread/list` contract explicitly rejects a nonempty originator allowlist on local app-server. `originator` is useful metadata, not an authorization boundary.

Evidence: [project contract](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server-protocol/src/protocol/v2/project.rs), [project processor](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server/src/request_processors/projects.rs), [sections and list filters](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L1292), [thread metadata](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server-protocol/src/protocol/v2/thread_data.rs#L204).

### Terminal and host-tool reuse has a lifecycle boundary

Native `command/exec` and `process/*` handles belong to the originating connection; losing that gateway-to-app-server connection terminates their processes. A browser can reconnect through the still-connected gateway, but this is not a durable terminal reattachment service. `process/*` most closely matches Kodex's current unsandboxed host shell and acknowledges creation; `command/exec` uses configured sandbox/environment policy and returns its final response after exit, while streaming output separately. The user has now chosen independent process supervision, so keep the gateway-owned PTY supervisor and its bounded browser reconnect buffer. Do not use native execution for this terminal or add survival across gateway restarts; native execution remains useful for other future host actions whose required lifetime fits it.

Native `dynamicTools` plus `item/tool/call` can expose host actions to Kodex-created threads, with native thread/turn/call provenance. They do not replace the retained Kodex Control plugin/MCP interface for existing external callers. Keep that interface and its guards; put native delegates and shared host handlers behind it, removing preview-only operations. Deliberate access through Kodex's tool API is compatible with dedicated home isolation and does not require sharing desktop's runtime or private storage.

External callers must target a Kodex-owned thread explicitly: their own `_meta.threadId` can belong to a different native home. The current generated-app tool defaulting needs adjustment so it cannot implicitly resume/import that foreign conversation. Keep caller availability without promising shared conversation identity.

Evidence: [command lifecycle](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server-protocol/src/protocol/v2/command_exec.rs#L194), [process contract](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server-protocol/src/protocol/v2/process.rs), [dynamic tools and callbacks](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server-protocol/src/protocol/common.rs), [terminal plan](../../plans/gateway-terminal.md), [Kodex Control](../kodex-control.md), [current thread defaulting](../../apps/gateway/src/mcp.rs#L1823).

### Raw skill rewriting is a correctness problem as well as duplication

Kodex scans text for `$name` and appends a structured skill input when its catalog finds a match. It does not distinguish `[$foo](app://...)` from a skill mention or apply native connector-name collision rules. That can force a skill the native resolver would deliberately exclude. Let native turn processing interpret unbound text; keep structured selections from autocomplete. Recommend accepting native invalid-selection behavior instead of keeping the custom “selected skill was removed, reject the send” path solely for parity. Native skipping is a behavior change to document. Rich badges for raw text mentions do not justify a second skill resolver; use available native metadata or omit the enrichment.

Evidence: [Kodex raw resolver](../../apps/gateway/src/skills.rs#L243), [native selection](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/skills/src/selection.rs#L167), [native linked-mention parser](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/skills/src/mentions.rs#L79).

### Size of the ownership hotspots

These are approximate production physical lines, including comments, whitespace and types, excluding inline test modules and generated code. They measure areas to review, not guaranteed deletions; rows can include code that must remain.

| Area | Approximate lines | Interpretation |
| --- | ---: | --- |
| Queue engine and queue store | 1,312 | Strongest focused deletion target, plus related route/event glue |
| Turn lifecycle and runtime store | 571 | Partly replaced by native routing/queue; current-turn bridging remains |
| Gateway thread view, patch/projection and timeline normalization | 2,941 | Mixed protocol reconstruction and legitimate rendering; shrink selectively |
| Gateway event/replay/synthetic modules | 2,015 | Mixed-domain transport; not all queue or transcript code |
| Subagent projection | 317 | Mostly replaceable by native relationships and filtered lists |
| Terminal engine and routes | 768 | Process implementation shrinks; browser buffering/policy remains |
| Title generation | 463 | Optional product policy plus removable subprocess machinery |
| Self-control MCP and HTTP endpoints | 5,041 | Retained facade; simplify after responsibilities move to native owners |
| Automation scheduler/routes/store | 981 | Retained schedule/run policy; native queue replaces custom execution dispatch |
| MCP App surfaces module/routes/store | 1,965 | Retained browser host; native scope/metadata reduces adapter work |

The frontend timeline source is about 6,480 lines, including rendering. That is not a deletion estimate. The goal is to remove duplicated state ownership and protocol interpretation, rather than minimize UI rendering code at the expense of usability.

## Dedicated Kodex home and desktop coexistence

### Current behavior shares more state than the UI suggests

The gateway starts its own child app-server and inherits its environment. `CodexConfig` has no explicit home or ownership mode. With no external override, it shares the normal Codex home and therefore relevant saved sessions, project/section state, configuration, skills/plugins and authentication storage selection. `KODEX_DATA_DIR` isolates the gateway database; it does not isolate app-server state.

That does not join desktop's in-memory runtime. App-server has per-thread writer locks across processes. A thread visible in the shared store may be live elsewhere and unavailable to resume in the new process. Native queues and shared SQLite do not make two independent live owners equivalent to two connections to one server.

Upstream tests demonstrate this even after a turn has completed: the second process cannot resume until the original runtime releases the writer. A separate `CODEX_SQLITE_HOME` does not bypass that ownership, and is not sufficient home isolation. Starting a newer binary against a shared home may also run storage migrations before any user turn; do upgrade experiments in a disposable home or a deliberate offline copy first.

Kodex actions with potential cross-app effects include login/logout; global defaults and MCP writes; plugin/skill changes; rename/archive/fork/settings operations against shared thread IDs; and maintenance that directly edits native storage. Those actions are not inherently invalid, but their scope must be explicit.

Evidence: [process launch](../../apps/gateway/src/app_server.rs#L104), [default config](../../apps/gateway/src/config.rs#L29), [account routes](../../apps/gateway/src/routes/account.rs), [cross-process writer lock](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/rollout/src/writer_lock.rs), [live writer acquisition](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/thread-store/src/local/live_writer.rs), [two-process ownership test](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server/tests/suite/v2/thread_resume.rs#L313), [native database migration](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/state/src/sqlite.rs#L266).

### Chosen target: a dedicated home and owned process

Use one real Kodex-only home and explicitly pass it as `CODEX_HOME` to every Kodex-launched Codex process. Pair it with a fresh gateway database/state directory. The implementation plan proposes `~/.kodex/native-v1/` with a `codex-home/` child; the paths and configuration interface still need implementation, and this report does not change the running environment. Do not add shared-home or desktop-attach modes to this redesign.

The implementation must cover the whole ownership boundary:

- Override inherited `CODEX_HOME` for child processes. Validate that the configured home does not resolve to desktop's home through a symlink or alias. `KODEX_DATA_DIR` alone is insufficient.
- Remove or deliberately scope inherited storage redirects such as `CODEX_SQLITE_HOME` and effective config paths such as `sqlite_home`; otherwise a dedicated home can still point at shared native databases. Apply the same home/binary policy to auxiliary Codex subprocesses until they are removed.
- Remove ambient Codex-auth overrides from managed launches, including `CODEX_ACCESS_TOKEN` and `CODEX_API_KEY`; require deliberate provider credential configuration for the new instance. A fresh home alone does not guarantee fresh sign-in: the native auth loader can read `CODEX_ACCESS_TOKEN` even when app-server disables its `CODEX_API_KEY` environment fallback. Validate this with synthetic credentials, not live desktop secrets.
- Keep native sessions, queue/project/section state, user configuration, Kodex-managed plugin/skill installs and caches, and credential storage in Kodex's chosen scope. Use native sign-in for that home. Manage and stop only Kodex's child process, with an independently pinned executable/schema pair.
- Start the replacement instance with empty native/gateway stores and a fresh namespace for browser state that references threads/projects. Do not import old history, credentials, queued work, schedules or IDs, and do not replay or convert old pending records. Leave old storage intact but unopened by the new runtime. Switch the deployed gateway deliberately so the retired gateway's scheduler/drainer is not unintentionally left running alongside the replacement; operate only on Kodex-owned processes.
- Keep the remaining shared boundary visible: the same project cwd means the same worktree files and project-local configuration. Native skill discovery also reads the real user's `$HOME/.agents/skills`, repository roots and configured extra roots independently of `CODEX_HOME`. Dedicated state does not imply isolated skill discovery or filesystem edits; document those boundaries rather than adding a custom discovery sandbox.

Separate runtimes sharing one home and a shared desktop runtime were evaluated but are outside the chosen target. Removing those modes also removes the need for desktop endpoint discovery, live writer handoff, credential bridging, or cross-application read-state synchronization. Explicit external calls through retained Kodex Control tools remain supported; they target Kodex state rather than sharing native conversation ownership.

A separate real Codex home also separates native file credentials and home-keyed keyring storage; a symlink to the same home does not. Use a deliberate native sign-in flow, not copied or symlinked credentials. Separate homes still share account quotas when signed into the same account. The protocol explicitly labels `chatgptAuthTokens` login internal-only; it is not a supported desktop credential bridge. Desktop's actual authentication mode was not inspected. Title generation needs the same ownership policy: its current hardcoded `codex` subprocess bypasses the configured gateway binary and can reintroduce version or home divergence.

Evidence: [home-keyed native credential storage](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/login/src/auth/storage.rs#L154), [native skill discovery roots](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/ext/skills/src/host_roots.rs#L95), [storage path configuration](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/config/src/config_toml.rs#L367), [authentication contract](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server-protocol/src/protocol/v2/account.rs#L86). The audited title subprocess was in `apps/gateway/src/title_generation.rs:319`; the redesign has since removed that module.

Additional launch-auth evidence: [native ambient access-token loading](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/login/src/auth/manager.rs#L1536), [app-server auth initialization](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server/src/lib.rs#L579).

The public runtime supports stdio, TCP WebSockets and WebSockets over a Unix socket, plus daemon tooling and multiple connections. That is not evidence that desktop exposes its running sessions on a supported endpoint. The expected default control socket and inspected daemon metadata paths were absent on this machine; no private desktop endpoint was reverse engineered or called. These observations are background findings, not follow-up integration work.

Keep the existing owned stdio transport unless another requirement justifies changing it. In particular, `app-server proxy` forwards raw bytes to a Unix socket that expects HTTP upgrade/WebSocket framing; it is not a JSONL transport adapter.

Evidence: [Unix socket transport](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server-transport/src/transport/unix_socket.rs), [stdio-to-UDS forwarding](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/stdio-to-uds/src/lib.rs), [upstream remote client](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server-client/src/remote.rs), [public transport documentation](https://learn.chatgpt.com/docs/app-server).

WebSocket transport remains experimental in the public documentation. A native listener is not a replacement for Kodex's browser access boundary: keep localhost/trusted-network deployment explicit, and do not expose an unauthenticated listener or gateway publicly. Native remote-control pairing methods are another experimental surface; they do not establish a general third-party desktop attach contract.

### Stop owning desktop storage formats

The project-move maintenance path edits Codex's SQLite/rollout state directly. That is exactly the kind of ownership this redesign should retire. Native project updates, thread metadata updates and `thread/settings/update.cwd` cover parts of forward-facing relocation, but they do not prove equivalence to rewriting every historical cwd or performing a desktop worktree handoff.

Use native APIs for supported changes going forward. Historical relocation/import tooling is outside this fresh-start redesign; do not repair or extend it as a prerequisite. Never turn direct writes to desktop global-state files, rollout JSONL, authentication files, worktree metadata or SQLite into the integration layer.

Evidence: [existing move procedure](../maintenance/move-codex-project.md), [native settings and metadata](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L236).

## Relevant additional capabilities

| Capability | Relevance to Kodex | Priority |
| --- | --- | --- |
| Native goals: `thread/goal/set`, `get`, `clear`, lifecycle notifications | Offer persistent “work until this outcome” behavior without implementing a continuation loop; already present in 0.135.0 | High if this workflow is wanted; independent of cron automations |
| `thread/search` and new `thread/searchOccurrences` | Native history search and turn anchors; avoid a second gateway transcript index | High/medium |
| `thread/revert`, fork `beforeTurnId`/`lastTurnId`, `thread/delete` | Native conversation editing/navigation; preserve native constraints and distinguish transcript changes from filesystem undo | Medium |
| Native attachments | Store pull request/worktree/resource associations through idempotent attachment APIs instead of duplicating them in new gateway tables | Medium; not file upload |
| New `turn/settings/update` | Change supported settings on a running turn without silently changing future turns; result may be `targetUnavailable` | Medium |
| Background terminal list/terminate | Show and stop agent-created processes through native lifecycle rather than inferring them from terminal output | Medium |
| New subagent activity items, collab operations and direct-input capability | Correct rendering and controls for newer native multi-agent behavior | Upgrade requirement |
| New `sleep` and `functionCallOutput` items, richer errors/moderation/status | Ensure valid new events are not silently lost by old item allowlists | Upgrade requirement; presentation can remain minimal |
| New audio/local-audio inputs and realtime history | Potential mobile voice workflow; requires input/output UX and transport work | Optional, after core simplification |
| New account usage/workspace messages/auth recovery surfaces | Better native usage and policy/error presentation without scraping desktop state | Medium/optional |
| MCP event streams, richer server capabilities and scoped status | Better external-app surfaces and discovery with less gateway reconstruction | Medium, capability-gated |
| Native plugin install/uninstall/reconcile/search and extra skill roots | Expand only when there is a product need; continue using native plugin/skill lifecycle | Optional |
| Native filesystem/environment operations | A path toward remote runtimes without assuming every file is on the gateway host | Architectural follow-up, not a reason to rewrite local preview serving now |
| User verification, Bedrock setup, gateway OAuth, Daybreak metadata | Account/device/enterprise-specific capabilities with additional host or entitlement requirements | Defer unless required; do not advertise unsupported verification capability |

The current model catalog should remain the source for model choices, supported effort and modality. Do not add another static model table or implement deprecated `multiAgentMode` as a new selector. The release contract marks that selector as ignored in favor of the model/effort behavior.

Main adds `thread/attachmentOwner/list`, `thread/prediction/request`, and `account/bedrock/checkGovCloudRequirements`, plus `thread/prediction/updated`, compared with the inspected release. None is necessary for the first implementation stage. Keep unreleased main out of the production compatibility target.

Evidence: [released method definitions and gates](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server-protocol/src/protocol/common.rs), [new item types](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server-protocol/src/protocol/v2/item.rs), [model contract](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server-protocol/src/protocol/v2/model.rs), [attachment contract](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server-protocol/src/protocol/v2/thread_attachment.rs), [pinned main methods](https://github.com/openai/codex/blob/d0759639f20af955a5c6447f4683e99bf42ab6cf/codex-rs/app-server-protocol/src/protocol/common.rs).

## Implementation follow-through

The [implementation plan](../../plans/native-app-server-redesign.md) defines the proposed milestones, dependency order and exit conditions, including native message identity before queue promotion. Keep that document as the implementation sequence instead of maintaining a second roadmap here. No implementation milestone is complete. Optional new native UI features are evaluated separately from the ownership reduction.

Each implementation chunk should identify the established user need, why the simpler native workflow is insufficient (if adding custom logic), the native owner, the exact code/storage to remove, any user-visible behavior change and exit conditions. Start from fresh state instead of building compatibility or dual-write synchronization. Apply the necessity review to undecided features and to extra implementation complexity within retained features.

At each boundary, compare a focused replacement with adaptation of the old code and choose the simpler maintained result. The plan does not require preserving the current module structure or implementing every step as an incremental refactor. A replacement is complete only when its callers/contracts and behavior checks work and the superseded implementation is removed. This permission to replace code does not change the fresh-start decision to leave old user storage untouched.

## Validation required before deletion or release

- Two browser clients on one gateway: simultaneous sends/settings edits, identical repeated messages, queue reorder/delete/start, missed events, reload and reconnect converge from native state.
- Two connections to a Kodex-owned test app-server: approval resolved by the other client, pending request replay, disconnect/reconnect and reused request IDs never create actionable stale approvals. This is protocol validation, not desktop integration.
- Restart during queue submission and dispatch: preserve order and handle an uncertain acknowledgment without duplicate inference.
- Interrupt a turn with queued input: native automatic dispatch stays paused, and explicit `thread/queue/start` can start the selected eligible row. Confirm and document any change from Kodex's prior semantics.
- Queue simplification: newly queued messages use native settings applicable at execution, and normal live steering remains native. Verify the fresh instance neither reads nor replays old option-bearing rows or `pendingCommit` records.
- Queued-row promotion: two tabs editing/selecting the same row; queue deletion racing native dispatch; confirmed `deleted: false`; a row surviving failed cleanup after native dispatch; lost delete/steer acknowledgment; turn ending between deletion and steer; accepted-but-uncommitted input; and gateway/app-server restart at each transfer phase. State the single-gateway mutation assumption explicitly. All tabs must converge on recoverable pending/error state; no uncertain operation is blindly resent or silently discarded. No exact next-tool-call timing or instantaneous interrupt is required.
- History: freshly created threads in supported history modes, active streaming during resume, initial pages, item anchors, interrupted/failed turns, revert/fork, long histories and new item variants. Historical import/format conversion is out of scope.
- Subagents: direct-parent and descendant lists, unloaded descendants, internal workers, and read-only children whose direct-input capability is false.
- Dedicated-home isolation, using disposable home fixtures: inherited `CODEX_HOME` and `CODEX_SQLITE_HOME` cannot redirect Kodex into desktop state; all child launches use the chosen home; symlink aliases are rejected; config/auth/plugin/thread/queue operations stay in Kodex's scope. Do not use the live desktop home for destructive validation. Confirm the project-worktree sharing caveat in setup documentation.
- Fresh start: native and gateway stores are newly initialized; stale browser pane/project references cannot reconnect to old state; no old schedules or queued work are replayed. Existing storage is left untouched.
- Native projects: idempotent creation, duplicate roots, valid native IDs in new automation records, moved associations, section ordering, and reconnect refresh.
- Retained features: fixed-interval automation dispatch/run records; MCP setup/auth/config preservation; interactive/generated app surfaces and grants; Kodex Control caller support with explicit Kodex thread targeting; local docking/mobile layouts; PWA registration/update, subscriptions, notifications, badges and click routing.
- Remote-preview removal: no remaining preview routes, Caddy supervisor, preview-specific Control tools/skill or UI references; file previews and generated app surfaces still work.
- Retained independent terminal: TTY resizing, interactive input, output while the browser disconnects, reconnect buffering, survival across app-server restart, honest gateway-restart behavior, explicit termination, and permissions parity.
- Desktop fine pointer, narrow fine pointer and narrow touch browser checks for affected UI; preserve existing lifecycle and bandwidth guardrails while removing implementation-only tests.

No application test suite was run for this documentation-only audit. Schema generation/comparison and source inspection validate the audit's contract baseline, not end-to-end runtime compatibility. Independent lifecycle, peripheral-feature and desktop-coexistence reviews checked the original report; their queue semantics, experimental gating, terminal lifetime and integration qualifications were incorporated. The subsequent product direction selects a dedicated home and subjects every extra feature to the necessity review above. An independent review of that revision confirmed the queue/product recommendations and identified the ambient-skill-discovery caveat, now incorporated. Local link validation and `git diff --check` pass. Implementation work must meet the repository's test-first, two-client, independent-review and generated-contract requirements.

## Dependency strategy

Continue generating contracts from the exact supported binary. Prefer native IDs and payloads with a small adapter over mirrored handwritten models and permissive raw-payload guessing. Keep Kodex's generated OpenAPI boundary for its browser API and additional features unless a separate, reviewed transport change replaces it.

The upstream Rust `codex-app-server-client` demonstrates typed remote and in-process clients, including Unix/WebSocket transport, but its dependency graph includes the app-server/core workspace. It is not automatically a small, stable library replacement. Verify publication/support and dependency cost before taking it as a dependency. Do not embed the whole runtime merely to delete a small transport wrapper. The TypeScript SDK still wraps CLI execution; switching to it would not supply the complete interactive app-server surface. The newer Python SDK is useful reference material, but adding a Python service is not justified by this Rust gateway audit.

Evidence: [Rust client dependency graph](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server-client/Cargo.toml), [TypeScript SDK](https://github.com/openai/codex/blob/rust-v0.160.0/sdk/typescript/README.md), [Python SDK](https://github.com/openai/codex/blob/rust-v0.160.0/sdk/python/README.md).
