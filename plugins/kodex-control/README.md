# Kodex Control Plugin

`kodex-control` is the first-party Kodex plugin for guarded local gateway self-control.

It contains:

- `skills/generative-ui`: guidance for using Kodex-generated MCP App surfaces.
- `.mcp.json`: a gateway-hosted MCP server definition that runs `kodex-gateway mcp kodex-control`.

Install or reinstall from the Kodex web app via Preferences > Plugins. The focused gateway install endpoint is transitional; generic plugin listing and installation should replace it when Kodex grows a full plugin manager.

When updating this local plugin, bump the manifest version with a Codex cachebuster suffix before reinstalling so the installed plugin cache gets a fresh bundle. Prefer:

```bash
python3 "$HOME/.codex/skills/.system/plugin-creator/scripts/update_plugin_cachebuster.py" plugins/kodex-control
```

This preserves the base version and rewrites only the `+codex...` suffix, for example `0.1.0` to `0.1.0+codex.local-20260604-143000`.

The MCP server calls the running gateway over `KODEX_GATEWAY_URL`, defaulting to `http://127.0.0.1:8787`. Non-loopback URLs are refused unless `KODEX_ALLOW_REMOTE_SELF_CONTROL=1` is set.

Projects use native IDs and may have zero, one, or several organizational roots. `create_thread` and `spawn_thread` accept an explicit absolute `cwd`; it is required for zero-root and multiple-root projects. A single root supplies the default. Roots do not grant filesystem access, and changing a thread's project does not move its files or change its working directory.

`send_thread_input` activates only the explicitly targeted chat and submits one native queue row. It does not steer an active turn or override the native queue pause after Stop. A paused queue requires an explicit Start in Kodex; ordinary queued chats remain dormant after restart until loaded. Queue rows carry native input and use the chat settings at execution, without frozen per-row execution options.

`spawn_thread` uses its idempotency key for a guarded single attempt. A confirmed replay returns the small native thread/queue receipt. If creation or admission was attempted but its acknowledgement is unavailable, the same key reports uncertainty instead of creating another chat or resubmitting input. Inspect the target before deciding on a separate explicit action. Automation run history likewise distinguishes queued, dispatched and uncertain admission; dispatch does not mean inference has finished. `wait_for_automation_run` accepts `afterRunId`, the latest run ID already observed, and returns a different latest run record from the authoritative run history, including Run now. Omit it to accept the latest existing run. `wait_for_thread_event` uses `queueChanged` (`turn_queue.changed`) for native queue invalidation; refetch the queue for its current rows.

Thread organization uses native `list_thread_sections`, `create_thread_section`, `update_thread_section`, `delete_thread_section`, `list_section_threads` and `move_thread_to_section`. Use the built-in Pinned section from the native list to pin a chat; explicitly pass `sectionId: null` to leave a section. A move preserves the project and working directory. Native member order uses `beforeThreadId`; omitting it appends. Custom-section rename requires a name and preserves appearance unless supplied. Pinned cannot be renamed or deleted. There is no separate pin timestamp or previous-section restoration.

Every app-surface tool requires an explicit `threadId` from the connected Kodex gateway. MCP `_meta.threadId` is never used as a default or ownership proof; a desktop or other native-home chat is not imported. Control checks the target through a native metadata-only read before storing, presenting, or archiving a generated surface. Resume and fork reject supplied rollout paths or history.

App-surface tools render MCP App-compatible HTML in a sandboxed iframe. Generated surfaces block external network access by default unless explicit CSP/grants allow otherwise. Bridge calls are gateway-mediated; generated-provider MCP tool calls require user approval before execution even when a grant is present. Use `open_app_surface`, `update_app_surface`, `show_app_surface`, `get_app_surface`, and `archive_app_surface`. `open_app_surface` focuses the pane by default; use `presentation: "open"` only for intentionally quiet opens. `show_app_surface` preserves the server-side app-surface session/revision, but unsaved in-iframe UI edits may reset if the pane was closed, hidden, unmounted, or reloaded. Pass nested metadata as JSON objects, not strings: `grants: { "canSendMessage": true }` and `csp: { "connectDomains": [], "resourceDomains": [] }`, not serialized JSON or CSP header text. Generated app surfaces should be richer than chat alone: use visual grouping, branching choices, progressive disclosure, previews, direct manipulation, or repeated actions when they make the task clearer. Buttons are not inherently prompts: use local UI interactions for embedded-data behavior such as modals, tabs, filters, drilldowns, chart toggles, unit switches, and view changes; call the host bridge only when an action needs Codex, tools, external data, persistence, workflow continuation, or an explicit user decision. If a control sends `ui/message`, declare `grants.canSendMessage: true`.

`mark_thread_seen` requires the exact `completedTurnId` and `readRevision` from the canonical thread snapshot. It cannot mark an unknown head or choose the latest completion implicitly. A conflict requires reading current state and viewing that completion before acknowledging it; do not blindly retry with a newer ID. Shared unread badges use native completion identity rather than event counters.
