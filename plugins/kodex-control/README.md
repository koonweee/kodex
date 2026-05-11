# Kodex Control Plugin

`kodex-control` is the first-party Kodex plugin for guarded repository evaluation and local gateway self-control.

It contains:

- `skills/kodex-proxy-evaluation`: the canonical proxy evaluation skill.
- `.mcp.json`: a gateway-hosted MCP server definition that runs `kodex-gateway mcp kodex-control`.

Install from the Kodex web app via Preferences > Plugins. The focused gateway install endpoint is transitional; generic plugin listing and installation should replace it when Kodex grows a full plugin manager.

The MCP server calls the running gateway over `KODEX_GATEWAY_URL`, defaulting to `http://127.0.0.1:8787`. Non-loopback URLs are refused unless `KODEX_ALLOW_REMOTE_SELF_CONTROL=1` is set.
