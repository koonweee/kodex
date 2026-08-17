# Deployment

Kodex supports localhost and trusted private-network deployments. This document covers that security model, gateway configuration, project previews, the PWA, and browser notifications.

## Security model

Kodex does not have a gateway authentication or authorization layer. Do not expose it directly to the public internet.

ChatGPT or Codex login routes only manage upstream account state through app-server APIs; they are not access control for the gateway. A client that can reach Kodex may be able to:

- Open interactive shells with the permissions of the gateway process.
- Preview supported readable files on the host.
- Upload local helper assets for Codex input.
- Change global Codex MCP configuration and start configured local MCP commands.
- Operate project previews, automations, app surfaces, and other gateway features.

Use loopback for single-device access. For access from another device, bind only to a trusted VPN or tailnet address and provide HTTPS where browser features require a secure context.

## Gateway configuration

Defaults:

| Setting | Default |
| --- | --- |
| Gateway bind | `127.0.0.1:8787` |
| Database | `~/.kodex/gateway.db` |
| Image uploads | `${TMPDIR:-/tmp}/kodex/uploads/images` |
| Codex command | `codex app-server --listen stdio://` |
| Static frontend | Disabled until `KODEX_FRONTEND_DIST` is set |
| Preview ports | `10000-19999` |
| Kodex-owned Caddy admin | `127.0.0.1:20191` |

Supported environment overrides include:

```text
KODEX_BIND
KODEX_DATABASE_PATH
KODEX_DATA_DIR
KODEX_UPLOADS_DIR
KODEX_CODEX_BINARY
KODEX_CODEX_ARGS
KODEX_FRONTEND_DIST
KODEX_CADDY_BINARY
KODEX_KODEX_CONTROL_MARKETPLACE_PATH
KODEX_PREVIEW_BIND
KODEX_PREVIEW_PORT_RANGE
KODEX_CADDY_ADMIN_BIND
KODEX_PREVIEW_DATA_DIR
KODEX_VAPID_PUBLIC_KEY
KODEX_VAPID_PRIVATE_KEY
KODEX_VAPID_SUBJECT
KODEX_NOTIFICATIONS_RECHECK_DELAY_MS
```

Start from `apps/gateway/config/production.env.example` for a production-style local configuration.

Image uploads default to the system temporary directory so app-server can read `localImage` paths from its sandbox. If you override `KODEX_UPLOADS_DIR`, choose a location readable by the active app-server sandbox profile, such as a project root or `/tmp`.

MCP environment and HTTP header values are stored in local Codex configuration rather than gateway SQLite. Kodex masks them on readback, but this is a usability measure—not a secret manager. Removing a server removes its inline configuration but does not remove app-server-owned OAuth credentials unless upstream provides a supported credential-removal API.

## Project previews

Project previews assign stable local ports to development services through an isolated Caddy process owned by Kodex. Caddy is optional and not bundled. Install it separately and keep `caddy` on `PATH`, or set `KODEX_CADDY_BINARY`.

Kodex does not modify or reload another Caddy service. It creates its own process, generated configuration, data directory, and admin address. If Caddy is missing or cannot claim its configured ports, previews report `disabled` or `degraded` while the gateway continues running.

Binding rules:

- `KODEX_PREVIEW_BIND` explicitly selects the preview listener host.
- Otherwise previews use the concrete host from `KODEX_BIND`.
- If `KODEX_BIND` is a wildcard such as `0.0.0.0` or `[::]`, set `KODEX_PREVIEW_BIND` explicitly.
- Upstream development services remain loopback-only at `http://127.0.0.1:<port>`.
- Automatic public-port allocation starts at `10000 + <root service port>` and advances through `KODEX_PREVIEW_PORT_RANGE`.

Example: with a frontend on port `3000` and API on `4000`, create both services in the project settings, make the frontend the preview root, and route `/api/*` to the API service. On a gateway bound to `100.64.0.10:8787`, a chosen public port of `13000` makes the combined preview available to trusted-network devices at `http://100.64.0.10:13000/`.

## PWA behavior

The web app is installable as a progressive web app. Its service worker precaches built static assets only; API traffic, SSE, OpenAPI, uploads, and file previews remain network-owned.

Long-running tabs may show an update banner when a new static bundle is waiting. Applying it activates the bundle and reloads the page. App badge updates use gateway-owned unread completed-turn state and silently no-op when the browser lacks the Badging API.

## Browser notifications

Web Push is optional. Configure VAPID values on the gateway:

```bash
KODEX_VAPID_PUBLIC_KEY=<base64url-public-key>
KODEX_VAPID_PRIVATE_KEY=<base64url-private-key>
KODEX_VAPID_SUBJECT=mailto:you@example.com
```

`KODEX_NOTIFICATIONS_RECHECK_DELAY_MS` defaults to `2000`. The gateway records delivery attempts, retries temporary failures without resending to endpoints that already accepted a delivery, and disables stale endpoints only when the push service reports that they are gone.

Preferences > Notifications reconciles the current browser subscription with gateway state. Use its Test action to verify delivery. For deeper local diagnosis, inspect the `notification_deliveries` and `push_subscriptions` SQLite tables.

Push on phones and tablets requires a secure browser context. Localhost is accepted for development; remote access over a private network generally needs HTTPS termination. HTTPS does not make a public deployment safe—the gateway must remain private.
