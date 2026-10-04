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

Thread organization uses native `list_thread_sections`, `create_thread_section`, `update_thread_section`, `delete_thread_section`, `list_section_threads` and `move_thread_to_section`. Use the built-in Pinned section from the native list to pin a chat; explicitly pass `sectionId: null` to leave a section. A move preserves the project and working directory. Native member order uses `beforeThreadId`; omitting it appends. Custom-section rename requires a name and preserves appearance unless supplied. Pinned cannot be renamed or deleted. There is no separate pin timestamp or previous-section restoration.

App-surface tools render MCP App-compatible HTML in a sandboxed iframe. Generated surfaces block external network access by default unless explicit CSP/grants allow otherwise. Bridge calls are gateway-mediated; generated-provider MCP tool calls require user approval before execution even when a grant is present. Use `open_app_surface`, `update_app_surface`, `show_app_surface`, `get_app_surface`, and `archive_app_surface`. `open_app_surface` focuses the pane by default; use `presentation: "open"` only for intentionally quiet opens. `show_app_surface` preserves the server-side app-surface session/revision, but unsaved in-iframe UI edits may reset if the pane was closed, hidden, unmounted, or reloaded. Pass nested metadata as JSON objects, not strings: `grants: { "canSendMessage": true }` and `csp: { "connectDomains": [], "resourceDomains": [] }`, not serialized JSON or CSP header text. Generated app surfaces should be richer than chat alone: use visual grouping, branching choices, progressive disclosure, previews, direct manipulation, or repeated actions when they make the task clearer. Buttons are not inherently prompts: use local UI interactions for embedded-data behavior such as modals, tabs, filters, drilldowns, chart toggles, unit switches, and view changes; call the host bridge only when an action needs Codex, tools, external data, persistence, workflow continuation, or an explicit user decision. If a control sends `ui/message`, declare `grants.canSendMessage: true`.

`mark_thread_seen` requires the exact `completedTurnId` and `readRevision` from the canonical thread snapshot. It cannot mark an unknown head or choose the latest completion implicitly. A conflict requires reading current state and viewing that completion before acknowledging it; do not blindly retry with a newer ID. Shared unread badges use native completion identity rather than event counters.
