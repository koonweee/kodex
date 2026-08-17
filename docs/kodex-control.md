# Kodex Control

The first-party plugin at `plugins/kodex-control` gives Codex guarded access to Kodex itself. It bundles the `kodex-proxy-evaluation` and `generative-ui` skills and exposes a gateway-hosted MCP server for self-control tools and read-only resources.

## Install from Kodex

1. Start the gateway with a ready Codex app-server.
2. Open Preferences > Plugins in the web client.
3. Install Kodex Control, or select Reinstall to refresh an existing installation.

The install action adds the bundled marketplace, installs `kodex-control`, and emits `skills.changed`. Installation is unavailable when app-server is degraded; Caddy is not required.

For non-web development, override the marketplace path with `KODEX_KODEX_CONTROL_MARKETPLACE_PATH`. The default for a repository checkout is `.agents/plugins/marketplace.json`.

## Develop the plugin

When changing files under `plugins/kodex-control`, update the version suffix in `.codex-plugin/plugin.json` before reinstalling. Codex keys its installed plugin cache by version, so reinstalling the same version may retain stale content.

For example:

```text
0.1.0+codex.local-20260817-120000
```

If the Codex plugin-creator skill is available, its `update_plugin_cachebuster.py` helper updates only the `+codex...` suffix while preserving the base version.

## MCP server

The gateway binary hosts the plugin's MCP server:

```bash
kodex-gateway mcp kodex-control
```

It reads `KODEX_GATEWAY_URL`, defaulting to `http://127.0.0.1:8787`. Non-loopback URLs are rejected unless `KODEX_ALLOW_REMOTE_SELF_CONTROL=1` is set.

The server exposes guarded tools for:

- Gateway status.
- Project preview configuration.
- Thread creation and input.
- Generated app surfaces.
- Automation management.

It also exposes resources such as `kodex://status`, `kodex://projects`, `kodex://threads/{threadId}/app-surface`, and `kodex://automations`.

## App surfaces

Generated app surfaces let Codex open or update temporary, thread-bound HTML when direct interaction is clearer than chat. They should:

- Adapt to desktop split panes and mobile full-height sheets.
- Include useful fallback content.
- Request bridge grants explicitly.
- Keep embedded-data interactions such as tabs, filters, charts, and modals inside the iframe.
- Use `ui/message` only when an action needs Codex, tools, persistence, continued workflow, or an explicit user decision.

MCP tool and resource calls pass through gateway-owned grants and inherit Kodex's localhost/private-network security model. Generated-provider MCP tool calls also require user approval before execution. External network access remains denied unless an explicit future policy grants it.

## Example use

After installing the plugin, another project can invoke a bundled skill with a prompt such as:

```text
Use $kodex-proxy-evaluation to evaluate this repo for Kodex project preview proxy compatibility and propose proxy settings.
```
