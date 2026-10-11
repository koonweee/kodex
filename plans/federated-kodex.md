# Federated Kodex implementation plan

Status: Proposed
Date: 2026-10-11

## Pinned implementation baseline

- Baseline commit: `496eb35aae3e25786633c4d2ab8b356f809f430f` (`Plan federated Kodex architecture`).
- Verified on 2026-10-12 after fetching `origin/main`; local `main` and `origin/main` both pointed to this commit.
- Feature branch: `codex/federated-kodex`.
- Implementation worktree: `/Users/jtkw/Projects/kodex-federated`.

All federation implementation, tests, generated contracts, documentation and milestone commits must be developed in this feature worktree against the pinned baseline plus this feature branch's own changes. The original `/Users/jtkw/Projects/kodex` checkout remains on `main` for independent work.

Main may advance during implementation. Do not pull, merge, rebase or cherry-pick later `main`/`origin/main` changes into this branch, and do not periodically refresh the baseline. Do not copy evolving source, generated artifacts or local build outputs from the main worktree to keep the feature current. Resolve implementation questions from this feature checkout and its pinned contracts; later main changes are not an implementation dependency.

Catch up with main only during the final merge-back integration phase. At that point, fetch the then-current main, reconcile its changes with the completed feature, resolve conflicts and rerun the affected contract, regression, cross-executor/two-tab and service-lifecycle checks before merging. Record that integration commit and validation separately; retain the original baseline above as the historical implementation starting point.

This worktree setup does not mark implementation milestones complete or authorize deployment or pushing.

## Objective and agreed scope

Run one project-first Kodex web workspace across macOS and Linux executors on a personal Tailscale network. Split the current gateway responsibilities into independently supervised federator and executor services. The federator serves the built React app; a separate production UI service is unnecessary.

This plan supersedes the earlier proposal to add federation inside one running gateway process. It does not start implementation or authorize deployment.

Decisions from the design interview:

- One user with full access to the registered executors. Tailscale is the network access boundary; no public hosting, multi-user permission model, custom tunnel service or high availability.
- Separate federator and executor processes from the first release. Both initially run on the existing Mac; the federator itself needs no app-server, Codex account, PTYs or native home.
- Remote installations need backend executor services only. A standalone remote web UI is not an acceptance requirement.
- Full existing workflows work through the federator: projects, chats, native queues/goals/settings, approvals, terminals, files/uploads, MCP setup/apps, generated app surfaces, automations, accounts/usage, notifications and responsive docking. Existing native limitations remain, including operator-configured MCP OAuth callback forwarding.
- Kodex Control remains local to each executor. Agents receive their executor's local endpoint and cannot use Control to discover or dispatch work across the federation.
- Pinned, Projects and standalone Chats remain the sidebar structure. Projects and pins support one shared drag order across executors.
- Offline navigation survives browser reload through a persisted catalog cache. This is explicitly stale display metadata, never a transcript or execution authority.
- One federator is sufficient. Its outage pauses UI operations and push delivery; executors continue jobs and local automation schedules.
- Preserve existing notification recovery semantics. Do not add missed-completion scans, catch-up summaries or a new historical notification replay feature. Existing durable delivery attempts and bounded retries remain meaningful.
- A fresh Kodex instance and new URL are acceptable. Do not migrate the current installation or reuse its database, native home, credentials or push configuration.
- Installation, updates and restarts remain machine-local CLI operations. The UI handles registration, account sign-in, connection status and existing native settings.
- Support macOS and Ubuntu/Debian Linux with systemd user services. Cover x86-64 and ARM64 where the pinned official Codex distribution is available and verified.

Confirmed on 2026-10-12: preserve today's operator-configured callback forwarding for remote MCP OAuth. Manual callback forwarding is acceptable; automatic central callback routing is outside this release. Full parity includes existing functionality with its documented callback setup requirement.

## Current implementation anchors

- `apps/gateway/src/main.rs` starts app-server, ingestion, automation scheduling, terminal cleanup and notification delivery in one process.
- `apps/gateway/src/api.rs` contains executor state and the current public router/OpenAPI assembly.
- `apps/web/src/api/client.ts` creates one API client and builds unqualified resource URLs. `GatewayInstanceBoundary.tsx` and `instanceStorage.ts` validate and scope one instance.
- `apps/web/src/api/queryKeys.ts`, event subscriptions, pane targets and browser routing assume one executor.
- `apps/gateway/src/notifications.rs` and `store/notifications.rs` already persist pending deliveries, reclaim stale processing and apply bounded retries. Recovery is not universally "drop everything."
- Codex sign-in already requests native `account/login/start` with `chatgptDeviceCode`. No credential-copy mechanism or new login protocol is needed.
- `tools/kodex-service` is macOS/launchd-specific, pins official macOS runtime packages and manages a combined backend/frontend deployment.

Implementation must verify these anchors in the pinned feature checkout and subsequent feature commits, not against a moving main. Preserve the baseline Kodex Control behavior and instance-local ownership; reconcile later independent changes only at merge-back.

## Service and storage boundaries

```text
Browser / installed PWA
        |
        | primary HTTPS origin, HTTP + SSE + terminal WebSockets
        v
Federator service
  web assets + isolated sandbox origin, registry, ordering, cached navigation
  routing, aggregate status/badge, push subscriptions/provider delivery
        |
        +---- Mac executor ---- local app-server, files, PTYs
        |
        +---- Linux executor -- local app-server, files, PTYs
```

Use the current Rust gateway as the executor implementation. Add a federator crate/service rather than duplicating or remotely hosting native lifecycle logic. Keep the existing gateway package name initially if renaming would add churn. Shared contract helpers belong in a small library only when both services actually need them.

The federator must start with zero registered executors and without a Codex executable, native home or account. It treats the Mac executor like any other registered executor, including HTTP transport, identity checks, compatibility and failure handling.

| Owner | Authoritative state and work |
| --- | --- |
| App-server on each executor | Native projects/pins, chats/transcripts, ordinary queues, settings, goals, account and native approvals |
| Executor gateway | Canonical live projection, native approval projection, read state, queue-transfer recovery, PTYs, files/uploads, app artifacts/grants, automation schedules/runs, thread notification preferences and eligible delivery work |
| Federator | Its own persistent identity, executor registry, cross-executor presentation ordering, catalog cache/freshness, browser push subscriptions/provider credentials, aggregate read models |
| Browser | Drafts, focus/selection/IME, pane layout, scroll, dialogs and device-local preferences |

Use a separate federator instance directory and database, with its own lock and versioned schema. Each executor retains its own gateway database and dedicated real Codex home. Never open one service's SQLite database from another service.

The federator stores no transcripts, native approval decisions, queue payloads, model defaults, account secrets, arbitrary files or second automation scheduler. Small cached notification previews have the existing notification lifecycle, not a transcript archive.

## Setup and trust model

1. Install and start the federator and a fresh executor on the Mac as separate services and ports. Serve only the federator's browser endpoint at the new HTTPS URL.
2. Install Tailscale and a fresh executor service on each additional machine. Obtain the complete pinned official Codex runtime, verify its checksum and match the checked-in schema.
3. Restrict executor API reachability to the federator and explicitly allowed operator access through Tailscale grants. Give the user's browser devices access to the federator.
4. In Executors settings, add a gateway URL and display name. The federator validates endpoint policy, connects, reads persistent instance identity and checks compatibility before saving the binding.
5. Sign into each executor from the central account UI using its native device-code flow. Credentials remain on that executor. Registering an executor does not sign it in.
6. Read projects without activating chats. The unified sidebar appears as native catalogs become available.

Tailscale setup remains explicit operator configuration, with documented commands/policy examples; the installer must not silently change tailnet-wide policy. Prefer HTTPS executor endpoints exposed by Tailscale Serve and normal certificate verification. Permit loopback HTTP for a co-located executor. Do not support arbitrary public URLs, userinfo, arbitrary proxy destinations or redirect-following during registration/forwarding.

Document the personal full-trust boundary: a client authorized for the federator can operate every registered executor. Executor instance identity detects accidental replacement; it is not an authentication credential. Enforce the network policy and endpoint checks instead of treating an instance ID or forwarded identity header as authentication.

Add and enforce browser Origin/Host checks for mutations and WebSocket handshakes; these guards are not present in the current router. Configure the primary federator Host/origin explicitly, reject hostile or null browser origins, and define deliberate no-Origin service-call behavior. The sandbox origin must not gain direct API mutation access. Bind listeners so a LAN/public path cannot bypass the intended Serve/Tailscale boundary. The federator forwards only supported executor routes, never federation-management routes, arbitrary URLs or the local-only Control interface. No recursive federation.

Split executor routing into a loopback-only Control listener and a federation-facing API listener. The current router merges self-control with browser routes; proxy allowlisting alone cannot hide those routes on the executor's exposed listener. Managed agent Control bindings point only to the local Control listener. The federation-facing listener must reject self-control routes even when called directly over Tailscale. This scopes the supported Control interface; it is not a sandbox that isolates arbitrary host processes from network access.

Preserve the existing app-surface origin boundary: one primary UI/API origin plus a distinct federator-owned sandbox origin serving app-surface-sandbox.html. Configure VITE_KODEX_APP_SURFACE_SANDBOX_URL for remote clients; loopback hostname substitution is not a remote deployment solution. The sandbox can be a second HTTPS port/listener of the same federator service, exposed explicitly through Serve/grants, rather than a third service. Serve only sandbox/static assets there, with no executor or management API. Publish both origins' assets from the same release, and test exact origin/source validation on their postMessage bridge.

One federator manages the fleet in this release. Do not add federation-of-federators, automatic tailnet discovery or remote service installation.

## Identity, API and frontend connection contract

- Assign a stable federator executor ID and bind it to a persistent executor instance ID and endpoint. Reject duplicate registration of the same instance, including through a second hostname.
- Qualify all browser resource references by executor binding and native resource identity. Examples include projects, threads, turns, terminals, approvals, app sessions, uploads, login attempts and automation runs.
- Use executor-qualified browser routes and transport prefixes, conceptually `/executors/{executorId}/threads/{threadId}` and `/v1/executors/{executorId}/...`. Define the final route shapes in Rust/OpenAPI during M1/M2, not in a separate handwritten contract.
- Pin requests to the expected instance, including a server-enforced identity precondition on executor operations. A capabilities check followed by a request is insufficient if the service at the URL can change between them.
- An endpoint edit retaining the same verified instance preserves references. A replacement instance requires explicit registration as a new binding; old panes, drafts, cached catalog and order references never silently transfer to it.
- Disabling an executor stops new routing and subscriptions but preserves its metadata. Removing registration removes federation membership, not executor storage or running work. Existing panes become unavailable and preserve their local drafts.
- Fence in-flight reads and events by registry generation and verified instance. An old reply after endpoint change, removal or replacement cannot repopulate the new binding.
- Introduce one frontend connection context per executor: API client, query cache, capability/compatibility state, event subscriptions and local storage namespace. Federator-owned queries use a separate context/cache.
- Pane targets carry their executor explicitly. Changing sidebar selection, a filter, or the active pane must never redirect an existing draft, menu action, approval, upload or terminal.
- Generate both service contracts and frontend types from Rust. Reuse executor DTOs rather than manually cloning them for proxy endpoints. OpenAPI generation must cover the route prefix/transport mapping and federator-owned DTOs.
- Negotiate federator/browser compatibility separately from executor API compatibility. Initially require the supported executor API epoch and capabilities; block incompatible executors individually. Do not build protocol translation for old executor versions.
- Frontend update events belong to the federator's web bundle. A remote executor deployment cannot tell the PWA that a new frontend is available.

## Project-first UI and shared navigation

Keep Pinned, Projects and Chats as the main sidebar sections. Combine resources across executors and show a readable executor label. An optional executor filter is presentation only, not execution context or the main navigation mode.

- A project means one native project on one executor. Matching names or Git remotes do not merge projects or synchronize files.
- New project chooses an executor, then uses that executor's existing home-bounded directory picker.
- Project chat/terminal creation inherits the executor and sole native root. Existing chats retain their native working directory.
- Standalone New Chat exposes an executor choice, initially suggesting the last explicitly used available executor. Once editing/attaching input begins, changing target is an explicit draft action; never silently retarget or copy already uploaded paths.
- Mixed-executor panes retain existing docking and responsive behavior. Show executor identity on tabs/headers, terminal labels, approval dialogs, files and app surfaces.
- Executors settings shows connection state, last successful contact, verified instance, API compatibility, native readiness and sign-in independently. Gateway reachability does not imply app-server readiness.
- Native account, usage, models, permissions, skills, MCP and plugin settings are executor-scoped. Do not sum account quota values across executors, since the same account may be signed in on several machines.
- Automations are listed with their executor; new ones choose an executor/target, and schedules continue locally. No migration or cross-executor automation target.

The federator owns one global manual order for projects and one for pinned chats, shared across browser tabs. Native project and pinned membership remain authoritative; federation ordering never persists a second pin flag or mutates native order as a side effect.

Implement bounded move operations naming qualified item/anchor references and the displayed order revision. Apply the order mutation and revision atomically, publish an invalidation and refill authoritative order on reconnect. Reject stale/conflicting edits with refresh/review; do not send a full stale sidebar list that could erase concurrent work. Define first-registration/new-item placement deterministically. Confirmed deletion/unpin removes ordering references; offline/failed reads do not. Re-pinning after confirmed removal receives new-item placement.

Persist only navigation metadata needed for offline display: qualified IDs, titles, project relationships, known pin membership, ordering references, last successful observation and query/page coverage. Bound storage and paginated reads; keep all known project/pinned references and a bounded set of discovered chat summaries. Do not promise complete offline chat history or unseen catalog pages.

Cache replacement must distinguish a complete authoritative inventory from a partial page. Failed or omitted pages cannot prove deletion. Native invalidations and reconnects cancel/fence stale reads before refill. A restarted federator can show cached navigation immediately as stale, then refresh without activating chats. Runtime activity, approvals and account status become unknown when disconnected, not durable cache truth.

## Transport, live state and failure behavior

Start with a streaming route proxy and independent executor SSE channels through the same browser origin. Reuse the existing per-executor selected-thread/global subscription model. Do not introduce a merged globally ordered transcript stream.

- Preserve executor transport cursors, canonical projection revisions and complete-snapshot coverage separately. No comparison of revisions across executors.
- Federator registry/order/catalog invalidations have their own revision domain. Aggregate badges/status return per-executor freshness/coverage, not an invented cross-host native transaction.
- Stream responses incrementally with bounded buffers, cancellation and backpressure. Preserve executor status/error bodies and API preconditions. Avoid ordinary request timeouts for long-lived SSE/WebSockets while bounding connection establishment and health checks.
- A slow/offline executor cannot hold healthy executor responses, event processing or catalog refresh. Set bounded per-executor concurrency and cancel stale generation work.
- Preserve WebSocket subprotocols, close behavior, binary frames and input/resize semantics. Federator restart disconnects views but does not stop executor-owned PTYs.
- Route files, skill icons, uploads, app documents and generated resource URLs through the qualified origin. Preserve content types, CSP, caching and range requests for seekable previews. Do not rewrite opaque document contents as a routing strategy.
- Reconnect uses the existing canonical attach/read recovery for open panes. Overview/catalog reads never resume every chat or activate ordinary queued work.
- Disable remote actions while unavailable; keep visible content marked stale and retain local drafts/selection. No offline submission queue or automatic draft send on reconnect.
- A disconnect after command dispatch is ambiguous. Never automatically resend input, queue promotion, terminal creation or other non-idempotent writes. A dropped connection does not prove native cancellation.
- Stop, Send, queue policies, sparse settings, native config version checks, approvals and revert fencing remain executor-owned and keep their existing two-client guarantees.

Browser connection budgeting is part of validation: test several simultaneous executor/selected-thread SSE streams on the deployed HTTPS protocol. Only add connection multiplexing if measured limits require it; any envelope must retain independent source/cursor domains.

## Notifications and app isolation

Retain current notification eligibility, thread preferences, foreground presence suppression, exact-turn previews, unread ownership and bounded retry rules. Federation changes where provider delivery happens, not which completions count.

Proposed delivery boundary:

- Executors retain durable eligible delivery records and existing attempt/recovery bookkeeping, and prepare bounded previews from the delivery's exact native turn.
- The federator owns browser push subscriptions, VAPID credentials and provider calls. It also owns durable federator-originated test-notification jobs, which must work with zero registered executors.
- A bounded federator worker claims eligible executor delivery work through a narrow executor API, sends through the existing provider implementation, and reports per-subscription outcomes using the claim identity. Reuse the existing claim/retry state machine for executor completion work and federator-local diagnostic work. Each delivery has exactly one durable owner; do not copy executor completion jobs into a parallel federator queue.
- Expired claims and late outcomes are fenced. Subscription identities are federation-scoped; successful subscription outcomes survive retries. If provider success is followed by a lost outcome acknowledgment, duplicate delivery remains possible, as with existing ambiguous provider writes; do not promise exactly once.
- Only one provider-delivery path operates in executor service mode. Remove competing executor-local push sending there.
- Restart processes already-persisted eligible work under existing retry semantics. Never scan history or reconstruct notifications for completions that were not captured. Disconnected native execution keeps its existing capture limitations.
- The worker/badge endpoint aggregates authoritative executor badge state, preserving prior known counts with explicit incomplete coverage when a source is unavailable. Notification display is independent of badge count. Removal excludes a source deliberately; transient failure does not make it zero.
- Forward browser visibility/presence to the correct executor with scoped client identity. Notification routes and service-worker click handling carry the originating executor. No credentials/subscriptions are copied from the old installation.

MCP and generated apps retain executor-owned grants, bridge tokens and account provenance. Host-side bridge dispatch binds the immutable executor/session context; an iframe-supplied executor ID, URL or account cannot select another machine. Keep existing sandbox/CSP restrictions and test cross-executor substitution attacks. Artifact cache/refill and presentation requests remain qualified.

Codex device-code authentication is centrally usable while credentials stay native. MCP OAuth retains native callback constraints: Tailscale API routing alone does not route a browser's loopback callback to a remote executor. Preserve and document supported native callback configuration/operator forwarding; do not introduce a general OAuth callback relay or claim every third-party provider is automatically remote-ready.

## Milestones and exit conditions

### M0 Establish behavioral baselines and service contracts

- Inventory all current routes, URL constructors, global client state, background workers and feature ownership. Make the full-parity acceptance matrix below executable by linking closest tests.
- Characterize current notification enqueue/restart/claim/retry behavior and remote account/MCP flows with focused tests before moving ownership. Verify the pinned runtime's MCP callback URL/bind/port support and demonstrate the documented manual-forwarding setup for a remote executor; do not infer it from ordinary API reachability.
- Verify current native integration against the pinned generated schema and upstream app-server README. Do not upgrade native runtime or adopt unrelated upstream features for federation.
- Define and test service instance/config boundaries and identity/compatibility preconditions. Choose concrete endpoint allowlisting and Serve/grants setup for the supported topology.
- Record exact platform/runtime packages and validation hosts available. Lack of a required real platform proof remains an open exit condition.

Exit: ownership and preservation tests exist; API changes have a concrete Rust contract direction; no active work has been retargeted or production changed.

### M1 Split service bootstraps and packaging boundaries

- Add a federator crate/binary, independent configuration, instance lock/store and health endpoints.
- Keep app-server supervision, native home setup, ingestion, Control bindings, automation scheduler, terminal supervision and projection state in the executor. Split the loopback Control and federation-facing API listeners and bind managed Control explicitly to the former.
- Move web asset serving/update ownership into the federator, including the distinct sandbox/static origin. Make executor-only startup omit frontend assets and VAPID/provider delivery.
- Share code only where it prevents real duplication; remove superseded bootstrap paths in the final split rather than retain two federation implementations.
- Add tests proving federator startup without Codex and independent executor/federator shutdown behavior. Extend workspace build/test/trim coverage to new crates.

Exit: two independently runnable services; stopping/restarting the federator cannot terminate executor jobs or terminals; the federator serves the existing app shell.

### M2 Executor registration and safe transport

- Implement persisted registry, endpoint/identity validation, duplicate detection, enable/disable/remove, native readiness and API compatibility reporting.
- Add server-enforced expected-instance checks, generation fencing, qualified proxy routing and route allowlists. Add Host/Origin guards and tests for hostile sites, null/missing origins, wrong hosts and WebSocket upgrades. Verify direct federation-facing requests cannot reach Control.
- Forward HTTP/SSE/WebSockets with streaming and backpressure. Cover multipart/binary uploads, ranges, error responses, redirects and terminal shutdown.
- Generate OpenAPI/types and add fake-executor integration fixtures with deliberately colliding native IDs.
- Test registration and removal across two browser clients; registry snapshots and invalidation/reconnect must converge.

Exit: local and remote executors use the same boundary; replacement, stale replies, wrong identity, recursion and unsupported versions cannot dispatch commands.

### M3 Executor-scoped frontend and core workflows

- Replace singleton API/capability/compatibility/event state with explicit connection contexts and independent query caches.
- Qualify pane targets, storage namespaces, deep links, draft/attachment state and all URL builders. Keep the textarea mounted through layout and context presentation changes.
- Route chat creation/input/Stop/queue/goals/settings/approvals, project directories, history/subagents, terminals, uploads and previews through the owning connection.
- Preserve canonical snapshots/deltas, replay/refill and read receipts independently for each executor.
- Keep App.tsx a shell coordinator; extract responsibilities into domain modules rather than grow it.

Exit: two colliding-ID executors can be used in adjacent panes and two tabs with no cache/action/event crossover; one executor failing or requiring an upgrade leaves the other usable.

### M4 Federated catalog and project-first navigation

- Add bounded persisted catalog metadata with freshness, page coverage and deletion/invalidation fencing.
- Add shared global project/pin order and atomic revisioned move APIs; native membership remains authoritative.
- Build merged Pinned/Projects/Chats, executor labels, optional filter and context-derived creation.
- Add Executors management/settings and offline navigation states. Restore cached navigation after federator/browser restart without native chat activation.
- Test concurrent reorder versus creation/unpin/removal, failed/partial inventory, offline executor, stale page response and reconnect.

Exit: mixed projects and pins share one deliberate order across two tabs and reloads; stale/offline catalogs never delete unseen items or authorize actions.

### M5 Full remote feature parity

- Scope native account/device-code login/cancel/logout, usage, models, skills, permissions, sparse config edits, MCP/OAuth and plugin operations.
- Preserve automation schedules/run histories on their executor; confirm federation reads do not schedule or activate work.
- Route MCP/generated app documents, resources, bridges, grants and presentation events with immutable executor context. Verify real cross-origin sandbox loading and postMessage handshake on the deployed Tailscale HTTPS origins, including wrong-origin/source rejection.
- Ensure local Kodex Control creates/operates only on its executor, including when the federator is unavailable.
- Exercise files/seekable media, app surfaces, remote account callbacks and portal/modal labels through the deployed origin.

Exit: the full feature matrix passes through remote routes; credentials and app bridges cannot cross executors; remote MCP OAuth succeeds using the documented operator callback setup as agreed. A generic 'OAuth is unsupported remotely' notice is not parity.

### M6 Federated notifications and recovery

- Implement the claim/outcome delivery boundary using existing durable attempt rules, source eligibility and exact-turn previews.
- Move provider/subscription ownership and PWA test-notification controls to the federator. Disable competing local senders in executor mode.
- Aggregate badges with source freshness, route visibility correctly and qualify notification clicks.
- Test provider success/failure, stale subscription, partial recipient success, claim expiry, late acknowledgment, worker/federator/executor restart, unavailable source and missed native capture. Cover zero-executor diagnostic delivery and its durable restart/retry/partial-recipient behavior.
- Verify no history-derived catch-up notifications, no zeroing on unknown source and no duplicate automatic command submission.
- Run deterministic worker/browser tests. Leave real push-provider proof to the user-run manual command outside gateway-launched browser sessions.

Exit: notification behavior matches characterized baseline across the split; all available automated proofs pass and manual provider/device checks have explicit results rather than assumed success.

### M7 macOS and Linux installation and operations

- Extend/refactor the local service tool for separate federator/executor install, update, restart, status, logs and rollback. Keep shared packaging logic small and platform supervisors explicit.
- macOS uses independent launchd labels. Linux uses systemd user units; document prerequisites and lingering for operation after logout/reboot, with explicit operator enablement.
- Install executors without building/installing web assets. Install federator UI/sandbox assets without requiring a Codex runtime. Preserve frontend-only atomic updates of the shared asset release without restarting either service or mixing incompatible sandbox/main bundles.
- Pin complete official Codex packages/digests per supported architecture, verify executable version and fail clearly for unsupported packages. Do not use desktop app internals.
- Keep role updates independent and report API mismatch without taking healthy executors down. No browser remote-update controls or distributed upgrade coordinator.
- Document Tailscale Serve/grants for primary and sandbox origins, distinct API/Control ports and instance roots, fresh sign-in, app-server queue restart semantics, service rollback and federator backup.
- Maintain an explicit release evidence table for macOS ARM64, macOS x86-64, Ubuntu/Debian-family Linux ARM64 and Linux x86-64: exact tested OS release, package/digest, install/start/reboot/update/rollback evidence and result. Do not infer architecture support from a mocked installer. Mark unverified combinations unsupported until their required proofs pass.

Exit: clean installs, logout/reboot persistence, independent updates and frontend-only updates pass on supported macOS/Linux hosts; unsupported/unverified architectures are not claimed supported.

### M8 Integrated validation and fresh rollout readiness

- Run the complete acceptance matrix with one federator, a macOS executor and a Linux executor; exercise two same-user tabs.
- Review all storage and service boundaries, generated contracts, cleanup and public/private-network assumptions independently.
- Update README, architecture/deployment/service docs, AGENTS ownership rules and plans/index.md. Explicitly replace the current global "native order only" rule with native membership plus federator-owned cross-executor presentation order.
- Stage new service roots/ports and a new URL. Keep the currently installed Kodex service, database and home untouched. Build a concrete deployment/runbook; actual deployment remains separately requested.
- Remove dead singleton/proxy/bootstrap paths, obsolete tests and unused dependencies after replacements pass. Do not expand into unrelated cleanup.

Exit: all prior milestone exits, generated artifacts, relevant suites/trims and independent reviews pass; manual/native/platform evidence is recorded; no unverified required behavior is called complete.

## Acceptance matrix

| Scenario | Required evidence |
| --- | --- |
| Resource collisions | Identical native project/thread/approval/terminal/app IDs on two fixtures never share caches, URLs, grants or command targets |
| Shared mutations | Two tabs converge for registry, global order, projects/pins, titles/archive, read state, settings, queues, approvals and automation changes, including missed events |
| Editing continuity | Mixed panes, executor filtering, responsive resize and reconnect preserve drafts, attachments, selection, IME and focus without retargeting or sending |
| Native lifecycle | Canonical attach, Stop, Send/queue policies, promotion ambiguity, approval runtime reset, revert and late snapshots retain executor guarantees |
| Partial outage | One executor sleeping/disconnecting/restarting does not block others; stale content is labeled, mutations unavailable and prior badges preserved |
| Identity/version changes | Same endpoint/new instance, duplicate endpoint, late prior-generation replies and incompatible API epochs fail closed for that binding |
| Federator restart | Remote execution/schedules/PTYs continue; browser streams reconnect and refill; shared order/catalog/subscriptions survive |
| Catalog/order | Pagination/failure does not imply deletion; stale drag writes cannot erase another tab's order; native unpin/deletion wins membership |
| Full feature parity | Native accounts/settings/plugins/MCP, local Control, automations, files/uploads/media, app bridges and notification preferences work against a remote executor; MCP OAuth includes the documented manual callback setup as agreed |
| App boundary | Distinct primary/sandbox HTTPS origins load and communicate correctly; hostile origin/source and frame/account/executor substitution cannot redirect a grant; CSP and artifact recovery remain valid |
| Push/PWA | Provider outcomes/retries, presence, badge freshness and qualified click routes pass; no history catch-up; frontend update signals come only from federator |
| Platform lifecycle | Explicit OS/architecture evidence table records launchd/systemd install/update/restart/rollback and verified runtime acquisition; unverified combinations remain unsupported; old storage is untouched |

Start behavior-changing implementation with failing tests when practical. Use focused Rust/domain/component tests, streaming transport integration tests and Playwright two-tab flows. Add real browser evidence with agent-browser and bundled Chromium for layout, input modality, live SSE and cross-pane behavior; if the required skill/tool is unavailable, record that gap and arrange equivalent authorized evidence rather than claiming completion.

Responsive validation includes desktop fine pointer, narrow fine pointer, narrow touch, wide touch with a compact pane and hybrid input. Shared theme/control changes additionally require the repository's contrast suite and visual review.

Each implementation chunk gets an independent read-only review under the repository model policy, fixes and relevant checks before a focused commit. Run cargo fmt, relevant cargo tests and backend trim; regenerate OpenAPI/frontend artifacts; run frontend build/typecheck, relevant tests and frontend trim. Service-tool changes run the existing Python suite plus new Linux/role lifecycle tests. Before pushing, follow the target-size/clean rule. No deployment or push is authorized by this plan alone.

## Exclusions and deliberate limits

No cross-executor agent orchestration, chat/terminal/job migration, repository synchronization, shared filesystem, credential copying, logical cross-machine project merging, arbitrary custom sidebar sections, multi-user ACL UI, public internet hosting, failover federators, mesh federation, automatic discovery, remote installer/updater UI or exactly-once command delivery.

The federator is a single availability dependency for the unified interface and provider delivery. Executors remain execution authorities, and freshness is explicitly partial when any one is unavailable.

## References

- [Current architecture](../docs/architecture.md), [deployment](../docs/deployment.md), [macOS service](../docs/macos-service.md).
- [Native redesign](native-app-server-redesign.md), [responsive UI contract](responsive-ui-contract.md), [Kodex Control functionality](kodex-control-functionality.md).
- [Pinned app-server schemas](../apps/gateway/app-server-schema/0.160.0/json), [upstream app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md). Reverify the checked-in pin during implementation; upstream main may describe later behavior.
- [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) for private HTTPS and [grants syntax](https://tailscale.com/docs/reference/syntax/grants) for explicit network reachability policy.
