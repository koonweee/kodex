# Federated Kodex implementation validation

- Date: 2026-10-12
- Pinned source: `496eb35aae3e25786633c4d2ab8b356f809f430f`
- Feature branch: `codex/federated-kodex`
- Worktree: `/Users/jtkw/Projects/kodex-federated`

This audit records the implementation boundary reached without deploying, restarting an installed service or pushing the branch. The branch contains the split federator/executor runtime, qualified browser transport and state, federated catalog/order, remote workflow routing, notification split and role-specific service controller. It remains pinned to the source above; later `main` changes are reconciled only during merge-back.

## Automated acceptance evidence

| Area | Evidence |
| --- | --- |
| Service boundaries | Federator starts with its own identity/database and without Codex. Executor and Control listeners are disjoint. Shutdown tests prove federator lifecycle cannot terminate executor work. |
| Identity and transport | Federator integration tests cover endpoint policy, persistent identity, duplicate/replacement detection, generation fencing, compatibility, route allowlisting, HTTP/SSE/WebSocket streaming, multipart/binary bodies, ranges, exact upstream failures and terminal closure. |
| Resource collisions | Two fake executors deliberately reuse native IDs. Frontend/runtime tests verify qualified caches, pane targets, URLs, terminal/app-surface sessions, approvals and mutations remain bound to the owning executor. |
| Shared state | Federator registry and order mutations use revisions and publish convergence events. Two-client tests cover missed events, reconnects, stale writes, partial catalogs, failed sources and instance replacement. Existing same-user two-tab suites cover native projects/pins, settings, queues, approvals, read state, goals, automations and account/config refills. |
| Editing continuity | Workspace schema v2 binds panes and drafts to an executor. Unit and Chromium coverage preserve unsent text/attachments, mounted composition, responsive focus and assistant-text selection while timeline rows stream, settle, resize or remount. |
| Catalog/order | Complete fresh native inventories govern membership; failed or partial pages cannot imply deletion. Federator tests cover bounded persisted cache, generation fences, concurrent creation/unpin/removal, stale moves and restart recovery. |
| Remote feature routing | Account/device-code, usage, models, permissions, sparse native config, MCP inventory/resources/reload/OAuth initiation, plugins, automations, files/uploads, terminals and app surfaces resolve through an explicit executor runtime. App bridge tests reject wrong window, origin, resource URL and executor substitution. |
| Notifications | Executor jobs remain the durable completion source. Federator tests cover expiring claims, late outcomes, partial recipient success, stale subscriptions, retry/restart, unavailable sources, exact-turn previews, zero-executor Test jobs and aggregate badge freshness without history catch-up. |
| Real federated browser runtime | The opt-in bundled-Chromium fixtures start a disposable federator, executor gateway and pinned Codex. Terminal passed in desktop, narrow fine-pointer and narrow touch modes with two tabs, reconnect, reload, pane closure/reopen and Stop. Built-PWA passed static-only precache/update, clean-tab automatic update, draft-tab manual update, browser-dispatched Push and authoritative zero badge. Device-code passed real provider issuance, exact local cancellation, matching native completion and absence of credentials. |
| Service controller | Controller tests cover macOS launchd and Linux systemd-user rendering, independent role packaging/update/restart/rollback/status, atomic federator frontend exchange, bootstrap recovery, health checks, strict primary/sandbox origins and checksum-pinned official Codex packages. |
| Public contract and cleanup | Gateway and federator OpenAPI exporters have unique Cargo targets; both generated TypeScript contracts reproduce with no diff. Workspace Rust tests, frontend unit tests, production build, backend/frontend trims, service-controller tests and diff checks are the final automated gate. |

The full bundled-Chromium suite is the integrated browser matrix: 460 discovered cases, including desktop fine pointer, narrow fine pointer, narrow touch, wide touch, hybrid input, same-user two-tab convergence, SSE recovery, responsive panes, themes and app surfaces. The reproducible two-worker default run passed 368 cases in 8.8 minutes, with 92 opt-in contact-sheet or native cases skipped by environment gates. The real federated terminal, built-PWA and device-code cases were then run explicitly and passed. The footer geometry regression was stress-run 45 times across desktop, narrow pointer and touch after its assertion was changed to compare settled frame-to-frame layout; every repetition passed. Executor-isolated selection restoration passed five forced-remount repetitions, timeline density passed 70 cases across five viewport repetitions, and return-to-bottom overlay geometry passed ten repetitions.

The ignored real app-server Rust suite ran against Codex 0.160.0 with 21 of 30 cases passing. Nine existing native-behavior assertions failed around persisted client IDs, Control/automation outcomes, history/promotion/revert expectations and skill binding. None exercises the federator boundary or was changed by this validation chunk. They remain recorded as native-redesign follow-up rather than being presented as federation proof.

## Evidence that still requires deployed hosts or user action

These are required plan exit conditions and remain open. Automated or mocked results are not presented as substitutes.

| Evidence | Current result |
| --- | --- |
| Remote MCP OAuth callback | Pending. The operator-forwarded callback procedure is documented, but no remote executor/provider flow has been run. M0 and M5 remain open. |
| Deployed primary/sandbox/media path | Pending. No Tailscale HTTPS origins were staged, so cross-origin sandbox loading, postMessage, uploads/ranges and media playback have no deployed-network proof. M5 remains open. |
| Real Push provider/device | Partial. Real device-code issuance and cancellation and browser-dispatched Push passed through the federator. The installed-Chrome provider command remains user-run only, followed by target-device install, background delivery, click route and badge checks. M6 remains open. |
| Split macOS lifecycle | Pending. No fresh launchd executor/federator install, logout/reboot, independent update, frontend-only update or rollback was performed. Both macOS architecture rows remain unsupported. |
| Linux lifecycle | Pending. No Ubuntu/Debian systemd-user install, lingering/reboot, update or rollback was performed on ARM64 or x86-64. Both Linux rows remain unsupported. |
| Real native opt-in browser tests | Passed for the federated terminal, built-PWA and real device-code issuance/cancellation fixtures. The separate installed-Chrome provider proof remains pending as described above. |
| Independent M8 review | Passed after two review rounds. The first round fixed stale cross-pane selection ownership and root-wide offsets after prepends. The runtime-validation round then found gaps in cross-tab stream proof, ordinary presence ordering, per-executor presence, remote terminal ownership and the manual-provider epoch header. Those gaps were fixed with deterministic leader/replay/failover coverage, serialized executor-scoped presence plus lifecycle cleanup, immutable terminal routing and versioned provider requests. The final rereview found no remaining major or medium issues. |

No production URL, installed controller, current Kodex database, native home, account credentials or old storage was changed. A fresh rollout remains a separate authorized operation using the new roots and ports in [the service runbook](../federated-service.md).
