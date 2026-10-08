# Mastra Code SDK compatibility spike

[Running port status](../../plans/mastra-port.md) · [Decision handoff](../../plans/mastra-code-sdk-handoff.md).

An isolated experiment for a future Kodex TypeScript/oRPC gateway. It does not start or replace the production gateway. See the [plan](../../plans/mastra-code-sdk-spike.md) for accepted product decisions and validation status.

Backend validation on 2026-10-07: 51 tests, typecheck, build and independent review pass; the first existing-UI slice also passes 1,076 frontend tests, builds/trim, independent review and real two-tab browser acceptance in three viewport/input modes. The added shutdown characterization test reproduces a native title-write failure and confirms the completed answer survives reopening. Real ChatGPT requests passed in two separate processes using saved credentials. Production migration gates remain below.

Requires Node 24+:

```sh
cd spikes/mastra-code-sdk
npm ci --ignore-scripts
npm test
npm run check
```

Tests use the published SDK for sessions, tools, memory, goals, scheduling and persistence. Only the remote model is replaced by a local HTTP fixture. The oRPC tests use real localhost HTTP/SSE and multiplexed WebSocket clients; the new browser acceptance test additionally exercises the retained Kodex renderer against native SDK state. Tests create disposable profiles and projects. The restart test terminates only its own disposable child process.

## Existing Kodex UI spike

Milestone 3 is complete within the bounded chat spike. The existing Kodex shell, docking, composer and timeline use native Mastra snapshots through typed oRPC when explicitly selected. This is a WIP backend: unported controls remain visible and return ordinary errors. No app-server fallback or deployment is performed.

After dedicated-profile login, run the backend, optionally seeding project directories:

```sh
npm run login -- login --mode device
npm run build
npm run serve:built -- --project /absolute/project
# In another terminal, from the repository root:
cd apps/web
VITE_KODEX_BACKEND=mastra npm run dev -- --port 5174 --strictPort
```

The browser shares one oRPC WebSocket connection per tab for typed calls and live snapshots; HTTP RPC remains available to nonbrowser clients. Reconnect refills reads without replaying submitted commands. The backend binds `127.0.0.1:8789`; Vite sends both `/rpc` and unfinished `/v1` requests to that backend. The original frontend development target remains available without `VITE_KODEX_BACKEND=mastra`. Never point the Mastra frontend at the production gateway. No sandbox or gateway authentication is provided; localhost/trusted VPN only.

`--profile`, `--port`, and `--model` configure the backend; `KODEX_MASTRA_PROFILE` and `KODEX_MASTRA_MODEL` supply defaults. The model defaults to the previously verified `openai/gpt-6.1-sol`. The native settings API seeds missing memory/judge model choices with that provider and sets the accepted effectively unlimited goal evaluation count; existing memory model selections are preserved. Serving also enables native `backgroundTools.enabled` in this dedicated profile for child delegation. Use a model available to your account.

The serving runtime adds `delegate_child` and `message_child` using native background tasks and fresh native sessions. Parent tools address guidance by the native task ID. Children retain native history for the existing read-only inspector and do not appear as ordinary editable chats. Native ordinary subagents still expose activity/results, and native forks retain inherited history. Fresh children cannot delegate further or start native background model tasks; background shell processes retain their separate native behavior. A suspended/failed child reports native task failure and its live session is aborted. Interactive child question handling remains unfinished. Parent archive retires its captured native descendant subtree, including pinned descendants, while preserving history for read-only inspection.

The serving runtime also provides `request_user_input_async`. Its questions use the existing nonblocking cards; native tool calls and user-signal metadata retain questions and answer correlation across tabs and restart. This does not add a separate prompt or transcript store.

Projects are durable Kodex product metadata in `<profile>/data/kodex.db` (the configured profile app-data directory). CLI `--project` arguments seed projects once; browser creation selects a directory within the gateway home. Project root edits apply to future chats, while existing chats retain their native database and working directory. Deletion detaches chats into the standalone list without moving or deleting native history; unchanged CLI seeds do not resurrect deleted projects. Starting without `--project` supports standalone chats in the gateway home. Native model/reasoning/Fast settings and account display now work. The existing queue editor supports shared edit/reorder/remove/steer and conservative recovery. Browser projects, native names, pins, notification preferences and selected-chat archive are connected. Archive retains native history and retires captured native descendants. Attachments and other retained workflows remain in progress. Existing native histories are reloaded after backend restart; pending follow-ups are volatile and may be dropped as agreed. Waiting input retains enqueue-time settings; an explicit edit captures current settings. Unknown delivery never triggers automatic resubmission.

The browser proof uses a disposable native SDK backend and local model fixture, with Playwright's bundled Chromium:

```sh
cd apps/web
npx playwright test --config playwright.mastra.config.ts
```

It exercises desktop, narrow mouse and narrow touch with ports 5184/18789, separate from production and the ordinary dev commands. It does not access real credentials. Test status and remaining exit conditions are recorded in the running port log. The test-only fixture explicitly exits after awaited disposal; this does not prove native natural shutdown or safe hot retirement.

## ChatGPT smoke

```sh
npm run login -- login --mode device
npm run login -- status
npm run live
# Run again in a fresh process to check saved-login reuse:
npm run live
```

The default profile is `~/.kodex/mastra-spike`. Set `KODEX_MASTRA_PROFILE` to use another fresh directory. The login CLI also accepts `--profile /absolute/path` and `--mode browser`. A process uses one profile; it cannot switch accounts by changing directories halfway through execution. Existing Codex, Pi and stock Mastra credentials are not imported.

The live command uses a disposable project/history and sends one minimal prompt through native ChatGPT OAuth. It names the test thread to avoid a separate title-generation request, configures the same provider for the SDK's title/observational-memory/judge calls, preserves native memory behavior, and sets the goal evaluation limit to `Number.MAX_SAFE_INTEGER`. It writes those model settings only inside the spike profile. `KODEX_MASTRA_MODEL` selects another model available to the account; default `openai/gpt-6.1-sol` was verified on 2026-10-07. The account rejected the SDK-era `gpt-5.4` and `gpt-5.3-codex` identifiers. A stored login or static model catalog alone is not proof of model access.

Reports contain only execution status and token totals. Do not commit credentials, raw provider errors, model traffic or profile databases.

## Native harness benchmark

See the [benchmark plan/results](../../plans/mastra-code-sdk-benchmark.md). This opt-in command makes real ChatGPT requests using the saved Mastra profile and a separately authenticated app-server benchmark home:

```sh
KODEX_CODEX_BENCH_BINARY=/absolute/path/to/codex npm run benchmark
# Focused sample:
npm run benchmark -- --only sequential --repetitions 3
```

Use the schema-matched Codex 0.160.0 binary. Native `codex login --device-auth` must be performed with `CODEX_HOME=~/.kodex/mastra-spike/app-server-benchmark` and `-c 'cli_auth_credentials_store="file"'`; never point the benchmark at the production home. Optional `KODEX_CODEX_BENCH_HOME`, `KODEX_MASTRA_PROFILE` and paired `KODEX_MASTRA_MODEL` / `KODEX_CODEX_BENCH_MODEL` overrides are supported. Both harnesses must use the same underlying model.

The driver writes sanitized measurements to ignored `artifacts/benchmark-*/report.json` and `summary.md`. Project fixtures and native runtime stores are disposable. Each case uses a fresh worker process; RSS separates its Node overhead from the app-server child. Native prompts/tool inventories differ, cached usage can be unknown, and these short tasks do not measure long-context memory or complete account billing.

## Supported ChatGPT affinity

The runtime supplies `session-id` through the SDK's public per-step processor, scoped to native ChatGPT OAuth and the persisted thread identity. Native fixtures cover concurrent chats, tool continuation, retry and reopen. The full paired live rerun passed 28 turns, with 98.6% cache reuse on Mastra follow-ups; see the [running log](../../plans/mastra-port.md) for totals and limitations.

## Built-runtime memory evaluation

Use `npm run build` then `npm run benchmark:built -- --only memory-5 --memory-repetitions 3` for plain Node workers. `--concurrent-repetitions 3` repeats the active five-chat case. Reports distinguish `compiled-js` from `tsx`; the dependency versions remain pinned. Source-only output is ignored under `dist/`.

`node dist/memory-stages.js --scenario single-project --output artifacts/new-memory.json` measures import/mount/session stages without model calls. The `three-projects` scenario is separate; `--expose-gc` enables explicitly labeled diagnostic collections only. Output files must be fresh. See [results and limits](../../plans/mastra-memory-evaluation.md): built Mastra uses about 30–36% less RSS than tsx in the repeated workload, with most stage-probe growth at import time.

## Cache investigation

The [cache investigation](../../plans/mastra-cache-investigation.md) found a reproducible ChatGPT affinity gap in the pinned provider. The isolated diagnostic CLI compares request fingerprints, identical replays and header-only native sessions:

```sh
node --import tsx src/cache-evaluation.ts artifacts/new-screen screen
node --import tsx src/cache-evaluation.ts artifacts/new-affinity affinity
node --import tsx src/cache-evaluation.ts artifacts/new-native native-affinity
```

Historical diagnostic reports predate supported runtime affinity; current runtime-backed diagnostic baselines include it unless the diagnostic explicitly overrides the header. These opt-in commands make real requests with the dedicated native login and require fresh output directories. Raw request bodies stay in memory; artifacts contain hashes, lengths, allowlisted configuration, header-presence flags and usage. Fetch interception is experimental measurement code, not a production runtime change. The public API's explicit cache controls were rejected by the subscription endpoint in this evaluation; see the report for scope and controls.

## Ownership demonstrated

| Concern | Owner / integration |
| --- | --- |
| Chat execution, tools, history, settings and goals | Native Code SDK / Session / SQLite |
| Projects and execution directories | Kodex SQLite project membership/order; one native controller and Mastra instance per retained immutable execution binding in one Node process |
| Multiple chats | Distinct native Session/resource identity per chat; observers share it |
| Queue and Stop | Native `Session.followUp()` and `Session.abort()` |
| Scheduled prompts | Native `mastra.schedules`, with a small `prepare` hook supplying the target Session context |
| Reconnect | oRPC event iterator carrying fresh native display/history snapshots |
| OAuth, saved credentials and refresh | Native AuthStorage/provider implementation |

`Session.queueMessage()` inherited the current run's abort signal in this SDK version. `followUp()` already supplies an independent signal, so accepted follow-ups can run after Stop without a Kodex queue implementation. Pending follow-ups remain volatile across process restart.

A native schedule's trigger outcome acknowledges delivery/wake; it does not prove an assistant answer completed. The tests check persisted assistant responses separately. The persistent calendar is `mastra.schedules`; the SDK's local `threadScheduler` is a different, process-local facility.

## Configuration ownership checks

Native fixtures verify explicit chat identities/history survive global, project and environment resource overrides, including reopening two chats in one database. MCP fixtures verify namespaced global/project precedence, external file edits, existing-session tool refresh after native reload, and durable project disable state. Each affected project manager needs its own reload. See the [configuration audit](../../plans/mastra-config-isolation.md) for scope and the app-server comparison. The MCP fixture explicitly exits after assertions/awaited teardown; it does not prove natural process exit. Default MCP/plugins/hooks remain disabled pending product wiring or execution validation.

Current release pins are Code SDK **1.11.0**, Core **1.75.0**, Memory **1.36.0** and LibSQL **1.25.1**. Native model selection now persists one current model per thread. Core's released goal fix discards obsolete judge results after pause, clear or replacement, including when chat Stop leaves the judge finishing in the background. Native regression tests cover those paths; no local Core patch or product dependency on private completion hooks is used. The main goal controls now use native goal snapshots and commands. Use `/goal <objective>` or the existing goal modal; edits replace the native objective and reset evaluations/time, preserving an explicitly paused goal. Create/resume can start work. Pause/Clear stop automatic continuation without interrupting the current response; chat Stop stays independent. Native goals show evaluations and active time, with no token-budget input. Native pause reasons appear in the modal. The configured native profile judge is honored; an unset judge falls back to the captured chat model through the host’s registered native gateways.

## Limits before a production migration

- This is a compatibility proof, not a gateway or harness abstraction layer. The opt-in UI chat backend is under implementation; there is no production cutover, schema migration, or deployment command here.
- SDK `agent_end` / `sendMessage()` completion does not necessarily join trailing title generation and workflow-snapshot writes. Immediate `Mastra.shutdown()` closes SQLite before some writes finish. The focused shutdown test confirms the completed answer survives reopening while delayed title persistence fails, even after `Memory.settled()` and a 30-second native drain budget. This narrows the demonstrated risk to unfinished title/internal cleanup at shutdown; universal safe hot retirement is still unproven. Expected `CLIENT_CLOSED` diagnostics in that characterization test are not a failed assertion. See the plan’s native shutdown audit.
- The transport sends canonical snapshots of each pane's loaded native history range. Initial history discovers the newest 40 messages and includes all ties at the boundary; Load older history extends the range. Reconnect retains the pane's boundary, and new messages do not evict loaded rows. oRPC buffers one invalidation per consumer; overlapping native events force a new history read. Loaded ranges and tied timestamp buckets may exceed the nominal page size. This is not a delta protocol or a durable replay log. The revision covers observed Session events, not native database commits; late writes without a notification are not fenced. Continuous updates can postpone a read. Restart creates a new projection epoch.
- MCP servers, arbitrary plugins/hooks, custom browser widgets, attachments, long-context observation/compaction, terminal supervision and existing Kodex product integrations are not exercised by this suite. MCP discovery and arbitrary plugins/hooks are disabled while dedicated-profile isolation is assessed. Skills now use supported session `homeDir`, with native discovery coverage across two projects. Some MCP/resource and instruction-path discovery still reads the real home; see the [configuration audit](../../plans/mastra-config-isolation.md). The spike uses a distinct config-directory name and explicitly selects native thread memory scope.
- No sandbox and no gateway authentication. The temporary transport binds only to `127.0.0.1`; future deployment remains localhost/trusted VPN only.
- Stable package versions are pinned in `package.json` and the lockfile. Direct memory/LibSQL dependencies pin the native implementation under test. TypeScript's unused-local/parameter checks cover this small package; the production Rust/React trim scripts do not inspect it.

The dependency tree currently reports an upstream optional Zod peer warning from Stagehand's OpenAI dependency. It does not fail installation or the exercised paths; browser automation was not tested.
