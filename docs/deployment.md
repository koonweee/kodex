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

For macOS login hosting, installation, start/stop and staged updates, see the [macOS service guide](macos-service.md).

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

The native redesign is validated for the intended personal-account deployment. Its startup selects a fresh instance root with a persisted identity and an exclusive process lock. `KODEX_DATA_DIR` selects that root; a `KODEX_DATABASE_PATH` override must resolve to its `gateway.db`. Do not copy old databases or desktop credentials into it. Wrong executable versions and failed native initialization stop startup. Existing production remains a separate operational deployment until an explicit replacement restart is requested.

Managed launches discard inherited `CODEX_*` variables and ambient OpenAI API credentials, set the instance's real `CODEX_HOME`, and request home-local SQLite, logs and file credential storage. Configure providers deliberately inside the new home. Local managed Codex configuration is currently refused because policy can override those paths. Organization-managed deployments are unsupported by the current isolation validation in 0.160.0: policy may override SQLite/log paths before client initialization, and the supported stdio contract has no pre-storage refusal or confinement option. A post-initialization check cannot prevent those writes. Do not bypass policy or treat command-line path pins as proof of managed-account isolation. Fresh native sign-in, authenticated operation and cold credential/history reuse have been verified for the user-confirmed personal account. This does not establish managed-account confinement. Dedicated runtime state also does not isolate shared project files, repository configuration, ambient skill discovery or same-account usage quotas. Native MCP credentials must use supported app-server operations; CLI MCP logout can affect shared keyring entries even in file-store mode.

Image uploads default to the system temporary directory so app-server can read `localImage` paths from its sandbox. If you override `KODEX_UPLOADS_DIR`, choose a location readable by the active app-server sandbox profile, such as a project root or `/tmp`.

MCP environment and HTTP header values are stored in local Codex configuration rather than gateway SQLite. Kodex masks them on readback, but this is a usability measure—not a secret manager. Edits use the native active user-layer file and version within the dedicated Kodex home; unknown policy fields and untouched secrets are not reconstructed. Deleting a value removes it from that user layer, so inherited configuration may become effective again. Removing a server does not remove app-server-owned OAuth credentials unless upstream provides a supported credential-removal API. A successful save remains saved if MCP reload is unconfirmed; retrying Reload does not repeat the config write. A reload acknowledgment does not establish server readiness.

## PWA behavior

The web app is installable as a progressive web app. Its service worker precaches built static assets only; API traffic, SSE, OpenAPI, uploads, and file previews remain network-owned.

Long-running tabs receive frontend deployment markers through the existing global SSE stream and ask their service worker to check for the new static bundle without a polling timer. They may then show a compact, theme-matched notice when that bundle is waiting. The notice includes an Auto-update toggle, off by default and stored on this device/browser origin. Enabling it leaves the current notice manual; future ready bundles show “Updating in 3s”, then 2s and 1s before activating and reloading. Dismissing cancels that notice; disabling the toggle cancels automatic updates. Background tabs restart the full countdown when visible. Failed updates offer an explicit retry. Reloading discards unsent drafts and other transient browser state. Without opt-in, applying Update remains manual. App badge updates use gateway-owned unread completed-turn state and silently no-op when the browser lacks the Badging API.

## Terminal lifetime

Terminal processes are supervised independently of app-server. Closing a pane only detaches that browser view; another tab can keep using the shell. Open terminal reuses a running shell, New terminal starts another, and Stop terminal terminates the shared shell. A view disconnected by another tab's Stop can be closed or explicitly reconnected to start a replacement.

The gateway permits eight sessions, keeps at most 1 MiB of reconnect output per shell and expires a shell detached from every browser after five minutes. Gateway exit or restart ends its terminals; they are not durable jobs. Managed shells default to the dedicated Kodex `CODEX_HOME`, but ordinary shell commands and startup files retain host access and can explicitly choose other environments.

## Browser notifications

Web Push is optional. Configure VAPID values on the gateway:

```bash
KODEX_VAPID_PUBLIC_KEY=<base64url-public-key>
KODEX_VAPID_PRIVATE_KEY=<base64url-private-key>
KODEX_VAPID_SUBJECT=mailto:you@example.com
```

`KODEX_NOTIFICATIONS_RECHECK_DELAY_MS` defaults to `2000`. The gateway records delivery attempts, retries temporary failures without resending to endpoints that already accepted a delivery, and disables stale endpoints only when the push service reports that they are gone.

Preferences > Notifications reconciles the current browser subscription with gateway state. Use its Test action to verify delivery. For deeper local diagnosis, inspect the `notification_deliveries` and `push_subscriptions` SQLite tables.

Reconnection and returning to a tab refill notification status, including changes from another tab. Enable/Disable success is shown only while the current authoritative device status confirms it. Missing browser capabilities, registration failures and gateway errors remain visible; a failed status read is not treated as a disabled subscription.

Browser subscription status does not confirm your device's OS notification settings. On macOS with Chrome 152 or newer, an installed Kodex PWA has its own OS notification permission. Check System Settings > Notifications > Kodex and its app-icon badge setting if alerts or Dock badges do not appear. A successful `setAppBadge()` call can leave the Dock badge invisible when those settings disallow it. See [Chrome's macOS notification guidance](https://developer.chrome.com/blog/notification-attribution-macos). Kodex’s Enabled status confirms the browser subscription; it does not establish that OS-level delivery is enabled.

Push on phones and tablets requires a secure browser context. Localhost is accepted for development; remote access over a private network generally needs HTTPS termination. HTTPS does not make a public deployment safe—the gateway must remain private.

## Fresh launch verification

The tested replacement is ready for a deliberate fresh launch with the personal-account and device-validation limits above. The user explicitly skipped target-device PWA installation/permission/badge/click/mobile/VPN-TLS checks, so those remain unverified. An actual production restart still requires an explicit request. Use a deliberately empty instance directory and the pinned executable; earlier marked instance formats are refused rather than converted. Leave old Kodex and desktop stores intact.

1. Build and run the documented backend, frontend, native and browser checks. Choose the new private bind/HTTPS endpoint and configure the production environment with an absolute new `KODEX_DATA_DIR`, executable and frontend path.
2. Stop only the retired Kodex deployment before starting the replacement, so its old automations and queue worker cannot continue alongside the new instance. This step requires an explicit production-restart request.
3. Complete the Account dialog's native device-code sign-in in the fresh instance. Device-code authentication must be enabled in personal ChatGPT security settings or by the workspace administrator; see [Codex authentication guidance](https://learn.chatgpt.com/docs/auth). A successful code issuance/cancellation test does not replace account authorization or establish managed-account isolation. Confirm account/model/usage readback, create a project/chat, send, answer an approval and Stop. No desktop credential copying or old-state imports are part of setup.
4. Restart only the new instance and verify account readback, a cold Send and canonical history reopening. Ordinary native queues wait until their chat is loaded; recreate desired automations and MCP configuration deliberately.
5. Check the new process home and storage locations against the selected instance, and verify retired Kodex storage remains unchanged. For desktop coexistence, distinguish writes made by the running desktop itself from Kodex-launched processes; do not promise that an active desktop's entire store is static.
6. Optional deployment validation, skipped by the user for this release: on the intended HTTPS/VPN endpoint and target devices, install the PWA, enable notifications, run Test with the app backgrounded, click the delivered notification and confirm the intended chat opens. Check nonzero/cleared unread badges where the OS supports them, two-tab notification preferences and one explicit waiting-worker update. Confirm unsupported APIs produce the documented graceful behavior. Target-device provider delivery, OS install/badges/click, mobile Safari and VPN/TLS require this deployment evidence in addition to the automated Chromium worker and loopback Chrome provider proofs.
