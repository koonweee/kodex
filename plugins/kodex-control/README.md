# Kodex Control Plugin

`kodex-control` is the first-party Kodex plugin for guarded repository evaluation and local gateway self-control.

It contains:

- `skills/kodex-proxy-evaluation`: the canonical proxy evaluation skill.
- `skills/generative-ui`: guidance for using Kodex-generated MCP App surfaces.
- `.mcp.json`: a gateway-hosted MCP server definition that runs `kodex-gateway mcp kodex-control`.

Install or reinstall from the Kodex web app via Preferences > Plugins. The focused gateway install endpoint is transitional; generic plugin listing and installation should replace it when Kodex grows a full plugin manager.

When updating this local plugin, bump the manifest version with a Codex cachebuster suffix before reinstalling so the installed plugin cache gets a fresh bundle. Prefer:

```bash
python3 /Users/example/.codex/skills/.system/plugin-creator/scripts/update_plugin_cachebuster.py plugins/kodex-control
```

This preserves the base version and rewrites only the `+codex...` suffix, for example `0.1.0` to `0.1.0+codex.local-20260604-143000`.

The MCP server calls the running gateway over `KODEX_GATEWAY_URL`, defaulting to `http://127.0.0.1:8787`. Non-loopback URLs are refused unless `KODEX_ALLOW_REMOTE_SELF_CONTROL=1` is set.

App-surface tools render MCP App-compatible HTML in a sandboxed iframe. Generated surfaces block external network access by default unless explicit CSP/grants allow otherwise. Bridge calls are gateway-mediated; generated-provider MCP tool calls require user approval before execution even when a grant is present. Use `open_app_surface`, `update_app_surface`, `show_app_surface`, `get_app_surface`, and `archive_app_surface`. `open_app_surface` focuses the pane by default; use `presentation: "open"` only for intentionally quiet opens. `show_app_surface` preserves the server-side app-surface session/revision, but unsaved in-iframe UI edits may reset if the pane was closed, hidden, unmounted, or reloaded. Pass nested metadata as JSON objects, not strings: `grants: { "canSendMessage": true }` and `csp: { "connectDomains": [], "resourceDomains": [] }`, not serialized JSON or CSP header text. Generated app surfaces should be richer than chat alone: use visual grouping, branching choices, progressive disclosure, previews, direct manipulation, or repeated actions when they make the task clearer. Buttons are not inherently prompts: use local UI interactions for embedded-data behavior such as modals, tabs, filters, drilldowns, chart toggles, unit switches, and view changes; call the host bridge only when an action needs Codex, tools, external data, persistence, workflow continuation, or an explicit user decision. If a control sends `ui/message`, declare `grants.canSendMessage: true`.
