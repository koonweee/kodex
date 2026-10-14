# Federated Kodex services on macOS and Linux

Kodex installs the federator and each executor as independent per-user services. The federator owns the PWA, sandbox assets, catalog order, browser Push provider and aggregate badges. An executor owns its Codex runtime, account, projects, conversations, Control listener, terminals, files, automations and eligible notification jobs. Both listeners remain loopback-only; Tailscale supplies private reachability and HTTPS.

The feature controller uses a fresh layout and does not modify the existing `~/.local/share/kodex` combined service:

```text
~/.local/share/kodex/federator/   # releases, controller, logs, operations
~/.local/share/kodex/executor/    # releases, controller, logs, operations
~/.kodex/federated-v1/federator/  # federator.db and identity
~/.kodex/federated-v1/executor/   # gateway.db, codex-home and identity
```

A fresh install copies a small bootstrap controller into its service root before submitting the first build. A successful update replaces that bootstrap with the release controller. If the initial build or runtime download fails, inspect `operation-status` and retry `update --repo /path/to/kodex --wait` through the installed `kodex-service` command.

## Install the hub Mac

Prerequisites are Python 3.9+, Rust, npm, Tailscale and a logged-in user launchd session. Run as the normal user, never with `sudo`.

```bash
./tools/kodex-service --role executor install --repo "$PWD" --wait
./tools/kodex-service --role federator install --repo "$PWD" \
  --port 8791 --sandbox-port 8792 \
  --public-origin https://kodex-hub.example.ts.net \
  --sandbox-public-url https://kodex-sandbox.example.ts.net/app-surface-sandbox.html \
  --wait

~/.local/share/kodex/executor/kodex-service autostart on
~/.local/share/kodex/federator/kodex-service autostart on
```

The staged hub commands use executor API `127.0.0.1:8789`, federator primary `127.0.0.1:8791`, and federator sandbox `127.0.0.1:8792`, leaving the existing combined service on `127.0.0.1:8787` untouched. A new installation without explicit ports defaults the federator to primary `8787` and sandbox `8790`; do not use those defaults while the combined service still owns `8787`. The executor's Kodex Control listener is separately allocated on loopback and passed only to its owned app-server. Set `KODEX_VAPID_PUBLIC_KEY`, `KODEX_VAPID_PRIVATE_KEY`, and `KODEX_VAPID_SUBJECT` only in the federator `config.json` `environment` object. Set `KODEX_NOTIFICATIONS_RECHECK_DELAY_MS` only on executors.

After both operations report `succeeded`, sign in to the fresh executor from the federated UI and register its private HTTPS backend URL in Preferences > Executors. A remote machine uses only the executor install command and is registered by backend URL; it does not install web assets.

## Install a Linux executor candidate

Packaged candidate targets use the checksum-pinned official Codex `0.160.0` musl packages for Linux x86-64 and ARM64. Neither target is supported until its host lifecycle row below is verified. The controller writes a systemd user unit and uses `systemd-run --user` for durable update, restart and rollback operations.

```bash
./tools/kodex-service --role executor install --repo "$PWD" --wait
~/.local/share/kodex/executor/kodex-service autostart on
systemctl --user status dev.kodex.executor.service
```

User services normally stop at logout. If this executor must keep running without a login session, explicitly enable lingering through the host's normal administrator process:

```bash
loginctl enable-linger "$USER"
```

The controller never invokes `sudo` or changes lingering. Verify the unit after logout and reboot before calling that host supported.

## Private HTTPS and grants

Create distinct private HTTPS origins for the federator primary surface and sandbox. For the staged hub commands above, route them to ports 8791 and 8792 respectively. Give the federator machine access to each executor's HTTPS API origin at port 8789. Do not expose the executor's loopback Control listener or use Tailscale Funnel.

Tailscale Serve persists configurations created with `--bg`; current Serve syntax and named Services are documented in [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve) and [Tailscale Services](https://tailscale.com/kb/1552/tailscale-services). Tailnet policy should use grants that restrict the primary and sandbox origins to the user and permit the federator host to reach executor APIs. Tailscale recommends grants for new policies; validate the exact `src`, `dst`/`svc:` and TCP permissions with the [grants syntax](https://tailscale.com/docs/reference/syntax/grants). HTTPS and tailnet membership do not make Kodex safe for public hosting.

The configured public origins must exactly match browser origins. The sandbox must remain a distinct origin. Executor registration resolves and pins private addresses, rejects public destinations and rechecks instance identity on routed work.

## Operations

Each installed controller supports `start`, `stop`, `restart`, `status`, `logs`, `autostart on|off`, `update`, `rollback --data-compatible`, `operation-status`, and `operation-wait`. The federator controller additionally supports `update-frontend`. Supply `--root` only for a nondefault installation. Full updates stage before stopping the selected role; a federator update never restarts an executor, and an executor update never restarts the federator.

`update-frontend` is valid only for the federator. It atomically exchanges the complete Vite release, including primary and sandbox assets, retains immutable chunks for open tabs, validates the API epoch, and does not restart either service. Executor releases contain no frontend. Federator releases contain no Codex package. Executor releases download the official package pinned to the checked-in schema and verify its SHA256, metadata, entrypoint, helper executables and reported version before changing the live release.

```bash
~/.local/share/kodex/federator/kodex-service update --repo /path/to/kodex --wait
~/.local/share/kodex/executor/kodex-service update --repo /path/to/kodex --wait
~/.local/share/kodex/federator/kodex-service update-frontend --repo /path/to/kodex
```

An operation returning means the per-user manager accepted it. Treat only `operation-status` state `succeeded` as completion. API version mismatches leave healthy executors running and appear as incompatible in the federator. There is no distributed updater or browser update control.

Rollback swaps only the selected role's release pointer and requires `--data-compatible`; persistent state is never rolled back. Stop/restart ends that executor's PTYs and app-server process. Ordinary native queued work remains dormant until its conversation is loaded after restart; retained automations activate only their own targets. Federator restart does not stop executor execution, schedules or PTYs.

Back up the federator by stopping it and copying its data directory, or use SQLite's online backup command against `federator.db` while it is running. Preserve `config.json` separately because it may contain VAPID secrets. Executor credentials remain in that executor's dedicated Codex home and are never copied by federation.

Native MCP OAuth callbacks still terminate on the executor. For a remote executor, forward the callback port/operator route to that machine for the duration of login, then complete the native flow; Kodex does not relay or persist OAuth callbacks in the federator.

## Release evidence

Unit and packaging tests do not prove host lifecycle behavior. A platform remains unverified until a real machine records the exact OS release and package digest plus install, start, logout/reboot, update, frontend-only update where applicable, rollback and health results.

| Platform | Exact tested OS release | Pinned Codex 0.160.0 package and SHA256 | Install/start/reboot/update/rollback evidence | Status |
| --- | --- | --- | --- | --- |
| macOS ARM64 | macOS 27.0.1 (26A434) | `codex-package-aarch64-apple-darwin.tar.gz`<br>`007df41b607dbbc8d204b9746ce7fed2d4ce6c813f44c32ceee54175ca796525` | Fresh executor/federator install, start, autostart, independent controller restart, device-code sign-in with authenticated restart, private HTTPS health and registry recovery passed on 2026-10-13. Logout/reboot, independent executor update, frontend-only update and rollback remain pending. | Unsupported: partial split proof |
| macOS x86-64 | Pending | `codex-package-x86_64-apple-darwin.tar.gz`<br>`4d50514b2d8acd81ca8cfee55b667b3dc4f7681b65bf3299ff06b11a064f8861` | No split-role host run recorded | Unsupported: proof pending |
| Ubuntu/Debian Linux ARM64 | Pending | `codex-package-aarch64-unknown-linux-musl.tar.gz`<br>`7f0fe42ff22ecfa3a47bc4a34f5b22c4218b431a4ec0aba51c7d98299f07900c` | Controller/unit tests only; no host run recorded | Unsupported: proof pending |
| Ubuntu/Debian Linux x86-64 | Debian 13.7 (trixie) candidate | `codex-package-x86_64-unknown-linux-musl.tar.gz`<br>`4fcc47ab57f52ff75363951a8761146cd10c8288bd86fed45487dbb204a16b71` | Feature snapshot staged on `sf-internal`; compiler/Rust/Node prerequisites and lingering are absent, so no service run is recorded. | Unsupported: host setup and proof pending |

The pinned SHA256 values match the official Codex `rust-v0.160.0` complete-package assets. Other OS/architecture combinations fail before download or service replacement.
