# Future Extensions Overview

## Status

Archived.

This document is not an implementation plan. It maps likely post-MVP product features to the Codex app-server APIs they can build on. Keep YAGNI in force: do not implement these until an MVP user need or explicit plan justifies them.

## Operating Rules

- Any future feature still starts with a failing test before implementation.
- Prefer extending existing gateway primitives before adding new subsystems.
- Keep API mappings DRY. Reuse the JSON-RPC client, event store, approval broker, and route error handling.
- Update [plans/index.md](index.md), `README.md`, and `AGENTS.md` when a future feature graduates into an active plan.

## Feature Map

| Feature | Product Value | App-Server APIs and Events | Gateway Additions |
| --- | --- | --- | --- |
| File explorer | Browse project files from the app. | `fs/readDirectory`, `fs/getMetadata`, `fs/watch`, `fs/changed` | Project-relative path policy, watch registry, file tree cache. |
| File editor | Read and edit files directly. | `fs/readFile`, `fs/writeFile`, `fs/createDirectory`, `fs/remove`, `fs/copy` | Text/binary handling, optimistic save, root enforcement. |
| Fuzzy file mentions | Fast `@file` insertion in composer. | `fuzzyFileSearch`, `fuzzyFileSearch/sessionStart`, `fuzzyFileSearch/sessionUpdate`, `fuzzyFileSearch/sessionStop` | Mention resolver, session lifecycle. |
| Sandboxed terminal | Run tests/builds from UI. | `command/exec`, `command/exec/write`, `command/exec/resize`, `command/exec/terminate`, `command/exec/outputDelta` | Terminal process registry, PTY UI, output replay. |
| Unsandboxed shell command | Match Codex `!` command behavior for trusted local users. | `thread/shellCommand` | Strong local-only warning and explicit enablement. |
| Review workflow | Ask Codex to review working tree, branch, commit, or custom target. | `review/start`, `enteredReviewMode`, `exitedReviewMode`, `turn/diff/updated` | Review queue, review result grouping. |
| Diff viewer | Inspect file edits while a turn runs. | `turn/diff/updated`, `item/fileChange/patchUpdated`, `item/completed` | Diff renderer, hunk comments, file change projection. |
| Conversation rewind | Remove recent turns from model-visible history. | `thread/rollback` | UI affordance and warning that file changes are not reverted. |
| File checkpoint rewind | Revert code as well as conversation context. | App-server does not provide this directly. | Gateway-managed git snapshots or worktrees. |
| Context compaction | Trigger history compaction manually. | `thread/compact/start`, `contextCompaction`, `thread/compacted` | Compaction status UI. |
| Goals | Track objective, token budget, and progress. | `thread/goal/set`, `thread/goal/get`, `thread/goal/clear`, `thread/goal/updated`, `thread/goal/cleared` | Goal panel and budget display. |
| Memory controls | Control memory eligibility per thread. | `thread/memoryMode/set`, `memory/reset` | Settings UI and destructive reset confirmation. |
| Skills manager | Browse and configure skills. | `skills/list`, `skills/config/write`, `skills/changed` | Skill catalog UI, enablement editor. |
| Hooks viewer | Show configured hooks and hook runs. | `hooks/list`, `hook/started`, `hook/completed` | Hook status panel and diagnostics. |
| Apps/connectors browser | Discover available apps and connector availability. | `app/list`, `app/list/updated` | App catalog cache and auth-state UI. |
| MCP manager follow-ups | Extend the completed [MCP manager](mcp-manager.md) beyond inspect/auth/reload/resource viewing. | `mcpServerStatus/list`, `mcpServer/resource/read`, `mcpServer/tool/call`, `mcpServer/oauth/login`, `mcpServer/oauthLogin/completed`, `mcpServer/startupStatus/updated` | Tool tester, config mutation, project-scoped views, and resource-template expansion. |
| Plugin marketplace | Install and manage plugins. | `marketplace/add`, `marketplace/remove`, `marketplace/upgrade`, `plugin/list`, `plugin/read`, `plugin/install`, `plugin/uninstall` | Marketplace trust policy, plugin detail UI. |
| Config editor | Edit user/project config. | `config/read`, `config/value/write`, `config/batchWrite`, `configRequirements/read` | Schema-aware editor, version conflict handling. |
| Experimental features UI | Toggle available feature flags. | `experimentalFeature/list`, `experimentalFeature/enablement/set` | Settings panel and restart/reload guidance. |
| External migration wizard | Import artifacts from other agents. | `externalAgentConfig/detect`, `externalAgentConfig/import`, `externalAgentConfig/import/completed` | Migration preview and selection UI. |
| Feedback upload | Submit feedback with logs. | `feedback/upload` | Form, log-file selection, privacy warning. |
| Realtime voice/text | Voice session attached to a thread. | `thread/realtime/start`, `thread/realtime/appendAudio`, `thread/realtime/appendText`, `thread/realtime/stop`, `thread/realtime/listVoices`, `thread/realtime/*` notifications | WebRTC signaling, audio capture/playback, transcript UI. |
| Windows sandbox setup | Help Windows users configure sandboxing. | `windowsSandbox/setupStart`, `windowsSandbox/setupCompleted`, `windows/worldWritableWarning` | Setup wizard and status UI. |
| Remote control/device identity | Trusted local controller identity. | `device/key/create`, `device/key/public`, `device/key/sign`, `remoteControl/status/changed` | Local-only enrollment UX and strict signing policy. |
| Automations | Scheduled or recurring Codex tasks. | Use `thread/start` and `turn/start` as execution primitives. | Scheduler, job store, run queue, review queue. |
| Parallel task dashboard | Run multiple sessions against one project. | `thread/start`, `thread/list`, `thread/status/changed`, event stream | Worktree manager, concurrency limits. |
| Pull request creation | Publish finished work. | Could be Codex-driven through MCP/apps/tools, not a core app-server endpoint. | GitHub integration, branch/worktree policy, PR form. |
| Public internet deployment | Use Kodex outside trusted network. | App-server account APIs are not gateway auth. | Add gateway auth, CSRF protections, session management, tenant boundaries. |

## Important Non-MVP Safety Notes

- `thread/shellCommand` runs unsandboxed with full access. Keep it disabled unless explicitly enabled for trusted local use.
- App-server filesystem APIs accept absolute paths. Any web-facing file feature must enforce project roots in the gateway.
- Device-key APIs are local-transport only and should not become arbitrary browser signing endpoints.
- Plugin APIs are marked under development upstream. Gate plugin UI behind an explicit feature flag.
- Realtime APIs are experimental. Keep them optional until the app-server contract stabilizes.
