# Kodex Control

The first-party plugin at `plugins/kodex-control` gives Codex guarded access to Kodex itself. It bundles the `generative-ui` skill and exposes a gateway-hosted MCP server for self-control tools and read-only resources.

## Install from Kodex

1. Start the gateway with a ready Codex app-server.
2. Open Preferences > Plugins in the web client.
3. Install Kodex Control, or select Reinstall to refresh an existing installation.

The install action adds the bundled marketplace, installs `kodex-control`, and emits `skills.changed`. Installation is unavailable when app-server is degraded.

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

Managed Kodex launches provide the actual bound gateway URL and running executable to their own Codex child through `KODEX_GATEWAY_URL` and `KODEX_GATEWAY_BINARY`. The plugin forwards these native `env_vars` to its MCP launcher. This supports an ephemeral or custom port and avoids an HTTP bootstrap lookup, a Cargo build, or accidentally invoking another installed gateway. Inherited Control bindings are stripped before setting the owned values. Wildcard listeners use loopback; a specific private/VPN listener also receives the child-only remote opt-in required to reach that address. This does not make the gateway safe for public exposure.

For an unmanaged development invocation, place `kodex-gateway` on `PATH` or set `KODEX_GATEWAY_BINARY` explicitly, and set `KODEX_GATEWAY_URL` to the intended gateway. A source-checkout launcher can also use an already-built `target/debug/kodex-gateway`. The MCP server otherwise defaults to `http://127.0.0.1:8787`; non-loopback URLs require `KODEX_ALLOW_REMOTE_SELF_CONTROL=1`.

The server exposes guarded tools for:

- Gateway status.
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

MCP tool and resource calls pass through gateway-owned grants and inherit Kodex's localhost/private-network security model. Generated-provider MCP tool calls also require user approval for the exact requested arguments and metadata before execution. Hosted MCP apps retain the app/account scope validated by their originating native call. Every app-surface tool requires an explicit Kodex chat ID; foreign MCP metadata cannot supply one. External network access remains denied unless an explicit future policy grants it.

## Example use

After installing the plugin, another project can invoke a bundled skill with a prompt such as:

```text
Use $generative-ui to create an interactive app surface for exploring these options.
```
