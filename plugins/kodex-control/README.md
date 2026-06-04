# Kodex Control Plugin

`kodex-control` is the first-party Kodex plugin for guarded repository evaluation and local gateway self-control.

It contains:

- `skills/kodex-proxy-evaluation`: the canonical proxy evaluation skill.
- `skills/generative-ui`: guidance for using Kodex-generated interactive UI panes.
- `.mcp.json`: a gateway-hosted MCP server definition that runs `kodex-gateway mcp kodex-control`.

Install or reinstall from the Kodex web app via Preferences > Plugins. The focused gateway install endpoint is transitional; generic plugin listing and installation should replace it when Kodex grows a full plugin manager.

When updating this local plugin, bump the manifest version with a Codex cachebuster suffix before reinstalling so the installed plugin cache gets a fresh bundle. Prefer:

```bash
python3 /Users/example/.codex/skills/.system/plugin-creator/scripts/update_plugin_cachebuster.py plugins/kodex-control
```

This preserves the base version and rewrites only the `+codex...` suffix, for example `0.1.0` to `0.1.0+codex.local-20260604-143000`.

The MCP server calls the running gateway over `KODEX_GATEWAY_URL`, defaulting to `http://127.0.0.1:8787`. Non-loopback URLs are refused unless `KODEX_ALLOW_REMOTE_SELF_CONTROL=1` is set.

Generated UI tools render self-contained HTML in a sandboxed iframe. V1 blocks external network access by default. Generated UI should be a richer surface than chat alone: use visual grouping, branching choices, progressive disclosure, previews, direct manipulation, or repeated actions when they make the task clearer. Buttons are not inherently prompts: use local UI interactions for embedded-data behavior such as modals, tabs, filters, drilldowns, chart toggles, unit switches, and view changes; submit to the thread only when an action needs Codex, tools, external data, persistence, workflow continuation, or an explicit user decision. Thread submissions should send one standalone human-readable message plus optional compact metadata.
