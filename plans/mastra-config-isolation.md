# Mastra dedicated configuration isolation audit

Updated: 2026-10-07. Status: Source audit complete; supported skills isolation implemented and tested. Complete isolation and enabling MCP/plugins remain pending. Pinned Code SDK `1.10.1`, core `1.74.0`. The follow-up uses local fixtures only; no live model requests or user credentials are needed.

The public `homeDir` option is useful but is not a complete discovery boundary in this pin. The dedicated app-data profile and explicit storage already keep native auth/history separate. Skills now use an additional supported state setting; MCP still has a real-home discovery gap. This change follows the completed affinity benchmark in a separate commit, keeping that benchmark attributable to affinity.

## Actual paths and supported options

In this table, `project` means the SDK's detected project root, `configDir` is the configured single directory name, and `profile.homeDir` is the dedicated profile's home directory.

| Area | Actual path / behavior | Supported isolation |
| --- | --- | --- |
| Auth and default settings | `MASTRA_APP_DATA_DIR/auth.json` and `settings.json`. Some native callers ignore explicit `settingsPath` and use default settings, including workspace LSP and model-use counters. | Set app-data environment once before native imports; keep `settingsPath` inside that same app-data directory. One account profile per process. |
| Main/vector storage | Without explicit storage, environment/settings/project and real-home `database.json` participate in backend discovery. | Explicit native `storage` with local database/vector URLs bypasses backend discovery; `MASTRA_DB_PATH` covers default DB callers. Explicit `omScope:'thread'` avoids OM-scope discovery. |
| Resource identity | Mounting still calls `getResourceIdOverride` even with explicit storage: environment, `project/configDir/database.json`, then real-home `configDir/database.json`. | Explicit per-chat resource/thread identities protect chat separation; this does not prevent the mounted project metadata from reading an override. Complete discovery isolation remains pending. |
| Hooks | `profile.homeDir/configDir/hooks.json`, then `project/configDir/hooks.json`; project hooks append. | Public `homeDir` is passed to the native hook manager. Hooks remain disabled pending behavior/concurrency validation. |
| Plugins | Global `profile.homeDir/configDir/plugins/{plugins.json,sources}`; project equivalent. | Public `homeDir` is passed to the native plugin manager. Native paths are suitable for later dedicated-profile installation/loading. Arbitrary plugin code and concurrency are not validated by path isolation. |
| Skills | Project and global `configDir/skills`, `.claude/skills`, `.agents/skills`, plus plugin skill paths. Global base comes from session state `homeDir`. | Set **`initialState.homeDir: profile.homeDir`** as well as public `homeDir`. The runtime now supplies both. Native discovery fixtures prove that all three dedicated global skill roots and project skill roots are loaded, while outside-home and other-project skills are excluded. |
| Instructions | Global `.claude`, `configDir`, `.config/claude`, `.config/<configDir without leading dot>` use real home. Project instructions remain native. | Existing `initialState.skipGlobalInstructions:true` suppresses global instruction loading. It does not suppress skills or the instruction-path deduplication read described below. Trusted host instructions have a public `hostInstructions` seam if needed later. |
| MCP discovery | Lowest to highest: optional real-home `.claude.json`; optional `CODEX_HOME/config.toml`; project `.claude/settings.local.json`; real-home `configDir/mcp.json`; project `.mcp.json`; project `configDir/mcp.json`. | Claude/Codex global imports are opt-ins. Native Mastra global MCP discovery ignores `homeDir`; there is no public home/discovery override in this pin. Keep MCP disabled until resolved or a namespace policy is accepted. |
| MCP state/OAuth | App-data `mcp-state.json` and `mcp-oauth/<fingerprint>.json`. | Already use dedicated `MASTRA_APP_DATA_DIR`; OAuth fingerprints include native project/server identity. |

`mcpServers` merges with and overrides file entries; it does not create programmatic-only discovery. `disableMcp:true` removes the manager entirely, including programmatic servers. `configDir` accepts one directory name, not an absolute or nested path, so it cannot redirect the real-home MCP path into the dedicated profile.

`disableEnvFile:true` prevents project `.env` from mutating shared process environment. It does not disable all native credential-to-environment mutation: normal local account initialization can seed stored API keys and gateway settings into environment. The public deployed credential-store-provider seam suppresses API-key seeding but introduces tenant identity requirements and does not suppress every gateway assignment. It is not needed merely to support the accepted single local account profile.

### Remaining gaps are not all prompt leakage

The active namespace is `.kodex-mastra-spike`. MCP and resource overrides therefore consult `~/.kodex-mastra-spike/{mcp,database}.json`, **not** stock `~/.mastracode` files. This avoids ordinary stock configuration collisions but still falls outside the dedicated profile. `MASTRA_RESOURCE_ID` can short-circuit resource discovery, but it is process-wide and would assign every project the same default resource identity; do not use it as a per-project isolation workaround.

The built-in `AgentsMDInjector` has a separate gap: its `getStaticallyLoadedInstructionPaths(projectPath, undefined, reader)` call omits the configured directory and global-instruction skip flag. That helper reads stock real-home instruction files using default `.mastracode`/Claude locations when constructing the set of paths to ignore. It discards their text after deriving paths. Actual reminder discovery is bounded to the project root. This demonstrates an unwanted configuration read, **not** global text injection into the prompt. The public input-processor option prepends processors and does not replace this built-in helper.

Prefer narrow upstream changes: thread `homeDir` through MCP/resource discovery and pass configured directory/global-skip options into instruction-path deduplication. Until then, distinguish dedicated auth/storage and corrected skill discovery from a guarantee of zero real-home configuration reads. Optional MCP/plugins/hooks remain disabled; their limitations need not force a custom loader or block the initial chat UI slice.

## Validation and remaining work

1. **Implemented:** supported state `homeDir` with a native discovery regression test. Two project controllers coexist; native skill listing and content reads include dedicated-profile/project fixtures and exclude outside-home/other-project fixtures across all three supported skill directories. Synthetic HOME is confined to the disposable test subprocess; production HOME remains unchanged.
2. Keep explicit storage/settings/OM scope and existing environment-file/global-instruction disabling. Verify auth/settings/history still resolve within the dedicated instance.
3. Test native plugin/hook discovery and two-chat concurrency before enabling those features. Their path configuration does not require a custom discovery system.
4. Resolve the native MCP home-directory gap before enabling MCP. Prefer an upstream supported option or an explicitly accepted dedicated namespace policy; do not swap `HOME` or build a replacement loader to conceal the gap.
5. Fix the built-in instruction-path deduplication options upstream; the existing global prompt skip is not a no-read guarantee.
6. Do not claim complete configuration isolation while unconditional resource-ID discovery remains. Explicit storage proves old databases are not opened, not that all legacy configuration files are unread.

Validation: the new discovery test failed before the fix with all three outside-home skills visible and dedicated global skills missing. After the fix, all 38 spike tests and TypeScript checks pass; independent source/implementation review found no material issues.

## Source evidence

Findings were checked against the installed pinned package, not inferred from option comments. Versioned upstream sources at the package release commit:

- [Public config and composition](https://github.com/mastra-ai/mastra/blob/b21e46e19b469a25c8896bcee90afd58d6f1a890/mastracode/sdk/src/index.ts): `homeDir`, initial state, manager construction, explicit storage, resource override, environment loading and default settings callers.
- [Native workspace/skills](https://github.com/mastra-ai/mastra/blob/b21e46e19b469a25c8896bcee90afd58d6f1a890/mastracode/sdk/src/agents/workspace.ts): `buildSkillPaths` and `getDynamicWorkspace`.
- [MCP configuration](https://github.com/mastra-ai/mastra/blob/b21e46e19b469a25c8896bcee90afd58d6f1a890/mastracode/sdk/src/mcp/config.ts) and [manager](https://github.com/mastra-ai/mastra/blob/b21e46e19b469a25c8896bcee90afd58d6f1a890/mastracode/sdk/src/mcp/manager.ts): discovery order, programmatic merge and OAuth storage.
- [Plugin paths](https://github.com/mastra-ai/mastra/blob/b21e46e19b469a25c8896bcee90afd58d6f1a890/mastracode/sdk/src/plugins/paths.ts) and [hook configuration](https://github.com/mastra-ai/mastra/blob/b21e46e19b469a25c8896bcee90afd58d6f1a890/mastracode/sdk/src/hooks/config.ts).
- [Project/storage paths](https://github.com/mastra-ai/mastra/blob/b21e46e19b469a25c8896bcee90afd58d6f1a890/mastracode/sdk/src/utils/project.ts) and [settings](https://github.com/mastra-ai/mastra/blob/b21e46e19b469a25c8896bcee90afd58d6f1a890/mastracode/sdk/src/onboarding/settings.ts).
- [Instruction loader](https://github.com/mastra-ai/mastra/blob/b21e46e19b469a25c8896bcee90afd58d6f1a890/mastracode/sdk/src/agents/prompts/agent-instructions.ts) and [credential resolution](https://github.com/mastra-ai/mastra/blob/b21e46e19b469a25c8896bcee90afd58d6f1a890/mastracode/sdk/src/agents/credential-resolver.ts).

The exported slash-command loader also uses real HOME without a `homeDir` override. The current runtime does not invoke it; revisit before adding command discovery.

No filesystem sandbox, public-hosting security or arbitrary plugin isolation is claimed. Deployment remains localhost/trusted VPN only.
