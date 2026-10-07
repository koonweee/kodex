# Mastra Code SDK compatibility spike

[Running port status](../../plans/mastra-port.md) · [Decision handoff](../../plans/mastra-code-sdk-handoff.md).

An isolated experiment for a future Kodex TypeScript/oRPC gateway. It does not start or replace the production gateway. See the [plan](../../plans/mastra-code-sdk-spike.md) for accepted product decisions and validation status.

Validated on 2026-10-07: 37 tests, typecheck and independent review pass. The added shutdown characterization test reproduces a native title-write failure and confirms the completed answer survives reopening. Real ChatGPT requests passed in two separate processes using saved credentials. Production migration gates remain below.

Requires Node 24+:

```sh
cd spikes/mastra-code-sdk
npm ci --ignore-scripts
npm test
npm run check
```

Tests use the published SDK for sessions, tools, memory, goals, scheduling and persistence. Only the remote model is replaced by a local HTTP fixture. The oRPC test uses real localhost HTTP/SSE clients; it does not validate a browser renderer. Tests create disposable profiles and projects. The restart test terminates only its own disposable child process.

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
| Multiple projects | One native controller and Mastra instance per project in one Node process |
| Multiple chats | Distinct native Session/resource identity per chat; observers share it |
| Queue and Stop | Native `Session.followUp()` and `Session.abort()` |
| Scheduled prompts | Native `mastra.schedules`, with a small `prepare` hook supplying the target Session context |
| Reconnect | oRPC event iterator carrying fresh native display/history snapshots |
| OAuth, saved credentials and refresh | Native AuthStorage/provider implementation |

`Session.queueMessage()` inherited the current run's abort signal in this SDK version. `followUp()` already supplies an independent signal, so accepted follow-ups can run after Stop without a Kodex queue implementation. Pending follow-ups remain volatile across process restart.

A native schedule's trigger outcome acknowledges delivery/wake; it does not prove an assistant answer completed. The tests check persisted assistant responses separately. The persistent calendar is `mastra.schedules`; the SDK's local `threadScheduler` is a different, process-local facility.

## Limits before a production migration

- This is a compatibility proof, not a gateway or harness abstraction layer. There are no production routes, schema migration, UI changes or deployment commands here.
- SDK `agent_end` / `sendMessage()` completion does not necessarily join trailing title generation and workflow-snapshot writes. Immediate `Mastra.shutdown()` closes SQLite before some writes finish. The focused shutdown test confirms the completed answer survives reopening while delayed title persistence fails, even after `Memory.settled()` and a 30-second native drain budget. This narrows the demonstrated risk to unfinished title/internal cleanup at shutdown; universal safe hot retirement is still unproven. Expected `CLIENT_CLOSED` diagnostics in that characterization test are not a failed assertion. See the plan’s native shutdown audit.
- The transport sends full snapshots for simplicity. oRPC buffers one invalidation per consumer; overlapping native events force a new history read. It is not a production paging/delta protocol or a durable replay log. The revision covers observed Session events, not native database commits; late writes without a notification are not fenced. Continuous updates can postpone a read. Restart creates a new projection epoch.
- MCP servers, arbitrary plugins/hooks, custom browser widgets, subagent rendering, attachments, long-context observation/compaction, terminal supervision and existing Kodex product integrations are not exercised by this suite. MCP discovery and arbitrary plugins/hooks are disabled while dedicated-profile isolation is assessed. Some native config discovery still uses the real home instead of `homeDir`; the spike uses a distinct config-directory name and explicitly selects the native default thread memory scope.
- No sandbox and no gateway authentication. The temporary transport binds only to `127.0.0.1`; future deployment remains localhost/trusted VPN only.
- Stable package versions are pinned in `package.json` and the lockfile. Direct memory/LibSQL dependencies pin the native implementation under test. TypeScript's unused-local/parameter checks cover this small package; the production Rust/React trim scripts do not inspect it.

The dependency tree currently reports an upstream optional Zod peer warning from Stagehand's OpenAI dependency. It does not fail installation or the exercised paths; browser automation was not tested.
