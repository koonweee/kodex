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
| Public contract and cleanup | Gateway and federator OpenAPI exporters have unique Cargo targets; both generated TypeScript contracts reproduce with no diff. The executor contract contains notification claims but no provider/subscription DTOs. A real Vite proxy smoke verifies the browser-visible Host on GET and Host/Origin on mutation. Workspace Rust tests, frontend unit tests, production build, backend/frontend trims, 77 service-controller tests and diff checks are the final automated gate. |

The full bundled-Chromium suite is the integrated browser matrix: 461 discovered cases, including desktop fine pointer, narrow fine pointer, narrow touch, wide touch, hybrid input, same-user two-tab convergence, SSE recovery, responsive panes, themes, app surfaces and the Vite/federator trust boundary. The reproducible two-worker default run passed 369 cases in 8.6 minutes, with 92 opt-in contact-sheet or native cases skipped by environment gates. The real federated terminal, built-PWA and device-code cases were then run explicitly and passed. The footer geometry regression was stress-run 45 times across desktop, narrow pointer and touch after its assertion was changed to compare settled frame-to-frame layout; every repetition passed. Executor-isolated selection restoration passed five forced-remount repetitions, timeline density passed 70 cases across five viewport repetitions, and return-to-bottom overlay geometry passed ten repetitions.

The ignored real app-server Rust suite ran against Codex 0.160.0 with 21 of 30 cases passing. Nine existing native-behavior assertions failed around persisted client IDs, Control/automation outcomes, history/promotion/revert expectations and skill binding. None exercises the federator boundary or was changed by this validation chunk. They remain recorded as native-redesign follow-up rather than being presented as federation proof.

## Plan-exit completion ledger

This ledger audits the feature branch against every milestone exit while retaining source baseline `496eb35aae3e25786633c4d2ab8b356f809f430f`. It separates repository work from evidence that inherently requires deployed services, external providers or additional operating-system hosts. No later `main` changes were merged or copied into the feature branch during this audit.

| Milestone | Repository implementation and automated evidence | Evidence still required by the exit |
| --- | --- | --- |
| M0 behavioral baseline | Ownership, route inventory, notification recovery, pinned native contract, endpoint policy and preservation tests are recorded in the baseline audit. Production remained untouched. | Complete a real remote-executor MCP OAuth flow with operator callback forwarding. |
| M1 service split | Independent federator/executor bootstraps, databases, listeners, assets and shutdown boundaries pass Rust, controller and browser tests. The final integration cleanup removes the combined gateway router and combined source-controller role. | None for the M1 exit itself. |
| M2 registration/transport | Registry identity, compatibility, generation fencing, allowlisting, HTTP/SSE/WebSocket streaming, hostile-origin rejection and colliding-ID fixtures pass generated-contract and integration tests. | None for the M2 exit itself. |
| M3 scoped core workflows | Executor-bound clients, caches, storage, pane targets, events and commands pass colliding-ID, partial-outage, replacement, two-tab and editing-continuity coverage. | None for the M3 exit itself. |
| M4 catalog/navigation | Persisted bounded catalogs, native membership, global revisioned order, offline state and stale-write fencing pass restart, concurrency, partial-page and two-tab tests. | None for the M4 exit itself. |
| M5 remote parity | Account/device code, usage, models, permissions, config, MCP/plugins, automations, files, terminals and app bridges route through immutable executor runtimes. Hostile bridge substitutions and local Control isolation have automated coverage. | Exercise the distinct primary/sandbox HTTPS origins, seekable media and the remote MCP callback procedure on the deployed Tailscale path. |
| M6 notifications | Durable executor claims, federator provider delivery, partial-recipient outcomes, retries/restarts, aggregate badges, visibility presence, worker updates and qualified click routes pass Rust, frontend and bundled-browser tests. | Run the installed-Chrome real-provider proof and verify background delivery, click routing and badges on the target device. |
| M7 service lifecycle | The role-aware controller, package boundaries, checksums, launchd/systemd rendering, independent operations, frontend exchange, rollback and recovery pass controller tests. The runbook and evidence table mark every untested host unsupported. | Run the documented clean install, logout/reboot, update and rollback matrix on the required macOS and Linux architecture hosts. |
| M8 integration | Generated contracts reproduce; complete Rust/frontend/controller suites, build, trims, default Playwright, opt-in terminal/PWA/device-code fixtures and independent reviews pass at the automated boundary. Documentation and ownership rules match the split architecture. | Complete the M0/M5/M6/M7 external evidence rows above to establish rollout readiness. An actual rollout is a separate authorized operation, not an M8 exit condition. |

The split-only cleanup passes its final checks and independent review. The feature branch stays active solely because the plan deliberately makes the external rows above part of rollout readiness. They cannot be replaced by mocks, local loopback fixtures or documentation claims.

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
| Independent M8 review | Passed after two implementation review rounds and a final split-only cleanup review. The first round fixed stale cross-pane selection ownership and root-wide offsets after prepends. The runtime-validation round then found gaps in cross-tab stream proof, ordinary presence ordering, per-executor presence, remote terminal ownership and the manual-provider epoch header. Those gaps were fixed with deterministic leader/replay/failover coverage, serialized executor-scoped presence plus lifecycle cleanup, immutable terminal routing and versioned provider requests. The cleanup review removed the combined runtime/controller and then corrected Vite trust headers, browser-visible status URLs and noncolliding staging ports. Its rereview found no remaining major or medium issues. |

No production URL, installed controller, current Kodex database, native home, account credentials or old storage was changed. A fresh rollout remains a separate authorized operation using the new roots and ports in [the service runbook](../federated-service.md).
