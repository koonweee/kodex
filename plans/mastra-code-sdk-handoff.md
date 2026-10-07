# Kodex → Mastra Code SDK: conversation handoff

Updated 2026-10-07. Read this before resuming the migration discussion.

## Current state: benchmark measured

The user returned and authorized the benchmark; dedicated app-server login is complete. The [short-task benchmark](mastra-code-sdk-benchmark.md) now has 12 cases / 28 passing turns. Read its results and limits before proceeding. No production deployment, restart, push, or upstream issue submission is authorized.

The short-task benchmark found about 14% more total main-turn input and 6.7× uncached input for Mastra in the repeated tasks. Investigating native cache reuse is the recommended next step; realistic coding workloads, config/plugin/MCP verification and a small real Kodex UI → oRPC → Code SDK chat slice remain follow-ons.

## Where the work lives

- Original repository: `/Users/jtkw/Projects/kodex`, on `main`. Other work may be happening there; do not overwrite its changes.
- Isolated linked worktree: `/Users/jtkw/Projects/kodex-mastra-spike`.
- Branch: `codex/mastra-sdk-spike`.
- Experiment: `spikes/mastra-code-sdk/` inside that worktree.
- Detailed decisions/results: [compatibility spike plan](mastra-code-sdk-spike.md).
- Commands and limitations: [spike README](../spikes/mastra-code-sdk/README.md).
- Implementation commits before this handoff:
  - `5f0fd1f`: scaffold and dedicated login profile.
  - `8e4a4f3`: concurrency, restart, goals, schedules, oRPC reconnect proofs.
  - `538a0c4`: native shutdown audit and reproducible detached-title failure.

The compatibility spike is complete. **The production migration is not implemented.** The Rust gateway, React frontend integration, installed service and existing conversation stores have not been replaced or deployed by this work.

## How we reached this choice

We initially evaluated a harness abstraction with the app-server adapter first and Pi later. Concern about reconciling opinionated harness semantics led to a Pi-only SDK investigation. Pi extension concurrency assumptions favored a process per open chat; the user became concerned about the overhead. We then evaluated Mastra core versus full Code SDK and selected **full Code SDK to avoid rebuilding its integrations**.

Do not resume the abandoned generic adapter or Pi implementation plans by default.

## User preferences and accepted decisions

The governing principle: **Mastra should own as much non-Kodex-specific behavior as possible; Kodex should implement only its product needs and unavoidable integration.** Prefer native semantics and frameworks over custom orchestration, persistence duplication, plugin rewrites or miscellaneous plumbing.

- Use full **Mastra Code SDK**, not an agent assembled from core alone.
- Eventual gateway: **TypeScript + oRPC**; keep React/Vite.
- One Node process can host many chats. The spike mounts a native controller and Mastra instance per project, with per-project native databases. Use a distinct native Session/resource identity per chat; browser tabs share that Session.
- Dedicated fresh Kodex profile; **ChatGPT subscription login is required**. No old conversation or credential imports.
- Auth, plugin installation and MCP configuration can initially use CLI/config workflows.
- **No sandbox**, no extra approval layer. Localhost/trusted VPN deployment only.
- Accept native queue/Stop behavior. **Waiting messages may be dropped on backend restart.** Do not build a durable queue or a pause/drainer state machine. Stop interrupts the current run; accepted follow-ups may proceed.
- Standard execution, not experimental durable/evented agents. Restart does not automatically resume interrupted work; user can send “continue.”
- Native goals/judge behavior with effectively unlimited evaluations: `Number.MAX_SAFE_INTEGER` is the native numeric cap used. No token budget initially. Stop/completion/error/native waiting still apply.
- Native observational-memory defaults; long-context behavior has not yet been validated.
- Native subagent live text/tool/status inspection plus persisted final results is sufficient. No messaging/Stop UI or custom durable full-child transcript store initially.
- Persistent **`mastra.schedules`** automations. Scheduled prompts **join the active conversation**, or wake an idle target. Do not substitute Code SDK’s process-local `threadScheduler`.
- Standard extension dialogs/notifications; retain a clear seam for arbitrary browser widgets. **Defer MCP Apps initially.**
- Eventual Kodex workflows still include projects/pins/read markers, automations, terminal supervision, file/generated-app panes, Control tools, docking and PWA/notifications. These are not implemented in the spike.
- The user prefers concise explanations and questions **one at a time**. Avoid large decision dumps or repeated confirmations of settled choices.
- Config isolation must not become hacky: use supported SDK options/environment variables, not `HOME` switching, monkey-patching or a custom discovery engine.

## Versions, auth and commands

Pinned and locked: Code SDK **1.10.1**, core **1.74.0**, memory **1.35.0**, LibSQL **1.25.0**, oRPC **1.15.4**; Node **24+**. Do not silently upgrade while benchmarking.

```sh
cd /Users/jtkw/Projects/kodex-mastra-spike/spikes/mastra-code-sdk
npm ci --ignore-scripts
npm test
npm run check
npm run login -- status
# Opt-in real model request:
npm run live
```

The user already completed native device login into `~/.kodex/mastra-spike`. Real ChatGPT requests succeeded in two separate processes using that saved login. Native SDK owns token refresh. Do not copy Codex/Pi credentials or print credentials/raw provider responses.

The verified model is `openai/gpt-6.1-sol`; the live script accepts `KODEX_MASTRA_MODEL`. The account rejected SDK-era `gpt-5.4` and `gpt-5.3-codex` model IDs. Native authenticated model discovery identified available IDs; this was a model-selection issue, not failed OAuth. Revalidate availability when needed, without unnecessarily repeating login.

Profile activation sets native `MASTRA_APP_DATA_DIR`/`MASTRA_DB_PATH`, passes explicit settings/storage paths, and keeps one profile per process because native provider state is shared. `KODEX_MASTRA_PROFILE` selects another fresh profile; it does not import existing credentials.

## What is actually proven

Latest validation: **17 tests pass**, typecheck/unused-local checks pass, independent review passes.

- Real published SDK executes concurrent chats across projects, using native workspace file tools and separate history/settings.
- Aborting and deleting one same-project chat leaves another active chat running.
- **Use native `Session.followUp()` for Queue.** `Session.queueMessage()` inherits the active run’s cancellation signal in the pinned SDK; `followUp()` already creates an independent one. No custom queue is needed.
- Goals automatically continue, finish and persist independently.
- A deliberately killed disposable child process loses waiting input; completed assistant history/model/thinking settings survive reopening in a fresh process. Reopening does not start a model run.
- Two real localhost oRPC HTTP/SSE consumers converge after disconnect/reconnect; disconnect does not cancel model execution. Slow clients refill from native snapshots.
- Coalesced native text events and overlapping history reads are fenced; aborted/disposed reads do not return stale results.
- Persisted native schedules join active runs, wake unloaded idle chats, and fire from the native calendar worker after runtime recreation.
- A small native `schedules.prepare` hook supplies the target Session request context. Native trigger success acknowledges delivery/wake, **not completed assistant execution**; tests verify saved assistant responses separately.

Only remote model responses are replaced by deterministic HTTP fixtures in these tests. They use actual SDK sessions/tools/storage/scheduling and actual oRPC transport. **No browser renderer, production frontend flow or production load has been validated.**

## Important correction: shutdown finding is narrow

Earlier explanations overstated this as a broad conversation-persistence blocker. Preserve the corrected conclusion:

- The writes are **Mastra-owned**, not a duplicate Kodex transcript store.
- `agent_end` means a native run ended, normally a turn. **Kodex stays running between turns.** The spike deliberately shut down immediately afterward to test cleanup.
- We already call native **`Mastra.shutdown()`**. Its bounded drain covers tracked evented/durable executions; it is not a universal flush for standard Code SDK background jobs.
- `Memory.settled()` joins observational-memory cycles and deletion vector cleanup, **not Agent-owned automatic title generation**.
- The deterministic shutdown test holds only the title response. The assistant answer is saved and the Session is idle. Even after `Memory.settled()` and `shutdown({ drainTimeout: 30_000 })`, releasing the title produces `CLIENT_CLOSED` on its save/internal cleanup.
- **Reopening proves the completed assistant answer survives.** This is not evidence that ordinary completed conversations disappear.
- `untilIdle` handles background-tool continuations, not all title writes. `thread_title_updated` confirms one title’s save, not a universal drain. Native `generateTitle.emitEvent: true` waits on normal title completion but releases on abort. Direct Agent `serverless.waitUntil` can expose title promises, but high-level Code SDK Session submission does not forward it.
- Matching native CLI shutdown also uses bounded process-exit cleanup, without a universal title drain.

The user accepted the recommendation to **keep native shutdown and treat this as a narrow title/cleanup limitation**, rather than build custom persistence. Do not reopen it as a prerequisite requiring a new Kodex save layer. Failure/abort persistence and arbitrary tool-process retirement are still unproven; do not generalize the completed-answer test to them.

`test/shutdown.test.ts` intentionally characterizes the native gap, so expected closed-store diagnostics can appear while all 17 tests pass. It is not a fix for the upstream behavior.

## Config/plugin/MCP work still pending

The SDK has supported `homeDir`, `settingsPath`, storage and `configDir` options. However, some MCP and legacy database discovery still uses the actual home directory rather than the supplied `homeDir`. Programmatic MCP server definitions merge with discovery; they do not automatically disable it.

The spike therefore defaults MCP off, disables arbitrary hooks/plugins, uses `.kodex-mastra-spike` as its native config-directory name, disables project `.env` injection into the shared process, and explicitly selects native default `omScope: 'thread'`. It avoids the TUI-oriented `wireSessionConcerns` helper’s active-session assumptions.

These choices **do not prove general extension concurrency or complete profile discovery isolation**. Investigate supported native configuration before enabling these features. The user has not agreed to abandoning the dedicated profile or sharing stock Mastra configuration; they specifically asked that isolation not be hacky.

The transport is also a proof, not a finished production protocol: full snapshots and one buffered invalidation per consumer; revision tracks observed native events, not database commits. Paging, high-volume streaming and unnotified late writes need appropriate production treatment without duplicating native durable state.

## Historical benchmark brief — results now available

Baseline is **current Codex app-server**, not bare model API or Mastra core. Compare the same model, project and tasks with comparable features/tools enabled. Report unavoidable harness differences openly.

Measure:

1. Total input/output tokens, cached versus uncached input, initial requests versus follow-ups.
2. Time to first useful response and total task completion time; report repeated samples rather than a single lucky request.
3. Process memory with one chat, several chats and several projects, including active execution and actual child processes where applicable.
4. Enough output/task correctness to ensure a faster or cheaper result is doing comparable work.

The observed **19,658 input tokens / 11 output tokens** came from a tiny live prompt using the stock Code SDK instructions/tool inventory. Most input was harness context, but **19.7k is total request input, not a measured incremental penalty versus Codex**. At handoff time there was **no comparable app-server token baseline**; the new benchmark supplies one. Do not conclude Mastra is more expensive from this figure alone. Distinguish cached tokens from uncached input and title/observer/judge/subagent calls from the primary request.

Earlier approximate idle RSS, local M4:

| Runtime | One / five empty chats |
| --- | --- |
| Code SDK, one process | 338 / 339 MiB (20 chats about 340 MiB) |
| Mastra core, smaller coding setup | 174 / 174 MiB |
| Pi, process per chat | 130–152 / about 670 MiB |
| Codex app-server | 74–88 / 95–102 MiB |

These are preliminary idle samples, mostly single-project; RSS includes shared pages. They do not establish active workload cost, per-project controller overhead or a fair feature-matched comparison.

Historical scratch artifacts may still exist: `/tmp/kodex-mastra-bench-RgxqIg` and `/tmp/kodex-appserver-bench-D3AGDo`. Treat them as disposable prior evidence, not prerequisites or final benchmark harnesses.

## Working discipline on resumption

Read the worktree’s `AGENTS.md`. Keep changes scoped and reviewable, use meaningful tests, independent implementation review, focused commits and updated plans. Explicit TypeScript/oRPC spike decisions supersede old Rust/OpenAPI requirements only for this isolated experiment. Production APIs remain unchanged.

The user returned, completed the isolated app-server login, and the short-task benchmark ran on `codex/mastra-sdk-spike`. Continue from the linked results; do not repeat login or reopen settled architecture choices by default.
