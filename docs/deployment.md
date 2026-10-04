# Deployment

Kodex supports localhost and trusted private-network deployments. This document covers that security model, gateway configuration, the PWA, and browser notifications.

## Security model

Kodex does not have a gateway authentication or authorization layer. Do not expose it directly to the public internet.

ChatGPT or Codex login routes only manage upstream account state through app-server APIs; they are not access control for the gateway. A client that can reach Kodex may be able to:

- Open interactive shells with the permissions of the gateway process.
- Preview supported readable files on the host.
- Upload local helper assets for Codex input.
- Change global Codex MCP configuration and start configured local MCP commands.
- Operate automations, app surfaces, and other gateway features.

Use loopback for single-device access. For access from another device, bind only to a trusted VPN or tailnet address and provide HTTPS where browser features require a secure context.

## Gateway configuration

Defaults:

| Setting | Default |
| --- | --- |
| Gateway bind | `127.0.0.1:8787` |
| Instance root | `~/.kodex/native-v1/` |
| Database | `<instance root>/gateway.db` |
| Native home | `<instance root>/codex-home/` |
| Image uploads | `${TMPDIR:-/tmp}/kodex/uploads/images` |
| Codex command | Codex **0.160.0** `app-server --listen stdio://` |
| Static frontend | Disabled until `KODEX_FRONTEND_DIST` is set |

Supported environment overrides include:

```text
KODEX_BIND
KODEX_DATABASE_PATH
KODEX_DATA_DIR
KODEX_UPLOADS_DIR
KODEX_CODEX_BINARY
KODEX_CODEX_ARGS
KODEX_FRONTEND_DIST
KODEX_KODEX_CONTROL_MARKETPLACE_PATH
KODEX_VAPID_PUBLIC_KEY
KODEX_VAPID_PRIVATE_KEY
KODEX_VAPID_SUBJECT
KODEX_NOTIFICATIONS_RECHECK_DELAY_MS
```

Start from `apps/gateway/config/production.env.example` for a production-style local configuration.

The native redesign is in progress and is not release-ready. Its startup now selects a fresh instance root with a persisted identity and an exclusive process lock. `KODEX_DATA_DIR` selects that root; a `KODEX_DATABASE_PATH` override must resolve to its `gateway.db`. Do not copy old databases or desktop credentials into it. Wrong executable versions and failed native initialization stop startup. Existing production remains a separate operational deployment until the redesign release gates pass.

Managed launches discard inherited `CODEX_*` variables and ambient OpenAI API credentials, set the instance's real `CODEX_HOME`, and request home-local SQLite, logs and file credential storage. Configure providers deliberately inside the new home. Local managed Codex configuration is currently refused because policy can override those paths. Cloud-managed account policy is an unresolved isolation gate in 0.160.0; the redesign must not be deployed on a claim of proven managed-account isolation yet. Dedicated runtime state also does not isolate shared project files, repository configuration, ambient skill discovery or same-account usage quotas. Native MCP credentials must use supported app-server operations; CLI MCP logout can affect shared keyring entries even in file-store mode.

Image uploads default to the system temporary directory so app-server can read `localImage` paths from its sandbox. If you override `KODEX_UPLOADS_DIR`, choose a location readable by the active app-server sandbox profile, such as a project root or `/tmp`.

MCP environment and HTTP header values are stored in local Codex configuration rather than gateway SQLite. Kodex masks them on readback, but this is a usability measure—not a secret manager. Edits use the native active user-layer file and version within the dedicated Kodex home; unknown policy fields and untouched secrets are not reconstructed. Deleting a value removes it from that user layer, so inherited configuration may become effective again. Removing a server does not remove app-server-owned OAuth credentials unless upstream provides a supported credential-removal API. A successful save remains saved if MCP reload is unconfirmed; retrying Reload does not repeat the config write. A reload acknowledgment does not establish server readiness.

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
