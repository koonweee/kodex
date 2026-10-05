# Kodex on macOS: login service and private HTTPS

Run the compiled gateway under your normal macOS account using launchd. The gateway serves the built frontend and supervises its dedicated Codex app-server; Node and Cargo are build tools, not production servers. This is a login service, not a pre-login boot daemon. The Mac must remain awake for remote access.

## Install

Prerequisites: a logged-in macOS GUI session, Python 3.9+ (the Command Line Tools Python works), Rust, npm, and internet access to the official OpenAI Codex GitHub releases. Run commands as yourself, never with sudo. The initial installation builds and starts Kodex; it does not enable login autostart until requested.

From the repository:

```bash
./tools/kodex-service install --repo "$PWD"

~/.local/share/kodex/kodex-service autostart on
~/.local/share/kodex/kodex-service status
```

If the first build fails, configuration is retained: fix the failure and run `~/.local/share/kodex/kodex-service update` once a release exists, or `./tools/kodex-service update --repo "$PWD"` before the first release exists. Do not rerun install or delete state to recover.

The default listener is `127.0.0.1:8787`. Choose another unprivileged port with `install --port 8788`. Both explicit starts and launchd starts check that the port is available. A conflict refuses startup and reports an inspection command; it never kills the listener. The gateway's own bind remains the final authority if another process takes the port after the check. Stop an older Kodex deployment deliberately before replacing it. The service never stops tmux jobs or unrelated listeners.

State defaults to `~/.kodex/native-v1`. Use `install --data-dir /absolute/fresh/path` to choose another fresh instance. Existing old stores are not imported, modified or removed; the gateway enforces its native instance rules. Sign in through Kodex's Account dialog after the initial start. The earlier disposable validation login does not sign in this installation.

The installation layout is:

```text
~/.local/share/kodex/
  kodex-service -> current/kodex-service
  config.json                   # private settings, mode 0600
  releases/<release>/           # gateway, frontend, Codex, Control marketplace, controller
  current -> releases/<release>
  previous -> releases/<release>
  dev.kodex.gateway.plist        # launchd definition
  logs/gateway.log
  logs/gateway-error.log
~/.kodex/native-v1/              # persistent gateway state and dedicated codex-home
~/Library/LaunchAgents/dev.kodex.gateway.plist  # present when autostart is enabled
```

Each release downloads the complete official [OpenAI Codex package](https://github.com/openai/codex/releases/tag/rust-v0.160.0) matching the checkout's `APP_SERVER_SCHEMA_VERSION` and Mac architecture. The controller pins the official archive SHA256 for each supported version/architecture; an unknown version, checksum mismatch, unsafe archive, missing helper, or failed native startup check aborts staging. Updating the schema version requires reviewing and adding the new package digests in `tools/kodex-service`.

The extracted `native/` directory retains upstream `bin/codex`, `bin/codex-code-mode-host`, `codex-package.json`, `codex-resources`, and `codex-path`; the release's `codex` symlink names its native entrypoint. Staging checks the executable's version and runs the helper's `--help` using temporary dedicated homes. Production still uses the gateway's dedicated Kodex `CODEX_HOME`. Each release owns its native package so rollback has no shared cache or desktop-app dependency. Plugin sources are packaged too; existing installed plugin caches still follow native plugin update semantics.

## Daily commands

Use the installed command by absolute path, or add `~/.local/share/kodex` to your shell's PATH:

```bash
kodex-service start
kodex-service stop
kodex-service restart
kodex-service status
kodex-service logs
kodex-service autostart on
kodex-service autostart off
```

- `start` loads the job and verifies the owned listener, native readiness/version, instance identity and served frontend. A loaded healthy job is left running.
- `stop` unloads the job and waits for its process to exit. It will not immediately restart. It does not change the next-login setting.
- `restart` stops and starts the installed release; it does not build.
- `status` reports launchd registration/PID, installed release, URL and autostart configuration. It is not a full health test; use `start` for that.
- `logs` follows both log files; Ctrl-C ends only the log viewer. Logs are not automatically rotated. Stop Kodex before manually rotating them.
- `autostart on|off` changes the next-login setting without starting or stopping the current process. Disable autostart **and** stop if you want it to stay off across logins.

launchd retries unsuccessful exits with a 30-second throttle. A startup port conflict exits cleanly to avoid a retry loop; resolve it and run `start` again. A clean gateway exit is not automatically retried. Stop/restart ends integrated terminals and interrupts active work; it is not a rolling update. Ordinary queued chats retain native dormant-after-restart behavior.

## Updates and rollback

Run meaningful tests for your changes first. Commit the intended changes so the installed source is reproducible, then:

```bash
kodex-service update
# Or deliberately select another checkout:
kodex-service update --repo /absolute/path/to/kodex
```

When a full deployment changes the service controller itself, invoke the new checkout controller for that update:

```bash
./tools/kodex-service update --repo "$PWD"
```

The installed command executes its current release's controller, so it cannot apply a new acquisition/build implementation until that controller is installed. This checkout command also upgrades an existing installation from desktop extraction to official downloads.

The default checkout was recorded at install time. Production frontend builds explicitly use same-origin API routing, overriding development API-base settings. The update command builds the current working tree, including uncommitted changes; it does not pull Git or run the full test suite. Avoid editing or concurrently building that checkout during the update.

Update downloads and verifies the official native package pinned for the checkout's schema, builds Rust with `--release --locked`, runs `npm ci` and the frontend build, and stages the complete release while the current service keeps running. Only after staging succeeds does it stop the owned job, switch the release pointers, start, and verify readiness. Updates also start a previously stopped installation. Login autostart is unchanged. A build failure leaves the running release untouched.

### Frontend-only updates

For frontend changes compatible with the running gateway, use:

```bash
./tools/kodex-service update-frontend --repo "$PWD"
```

Use the checkout command until a full update installs the new controller; afterward, the installed `kodex-service update-frontend` command is available too. This path runs `npm ci` and the production frontend build, but does not build Rust, download Codex, restart the gateway, or change the current/previous release pointers. Active chats and integrated terminals keep running.

The command requires a running, healthy owned service and matching frontend API epoch and native schema version. It stages the frontend beside the installed assets and atomically exchanges directories. Old hashed assets remain available for open tabs. It verifies the served frontend and unchanged gateway PID after the swap; a failed verification restores the prior frontend without stopping the service. This frontend-only recovery does not touch backend state. Use a full update when frontend changes require new backend behavior, even if the API epoch has not changed.

As with full updates, the source is the selected checkout's working tree. Use a clean checkout or a committed snapshot to avoid deploying unfinished edits, and avoid concurrent edits/builds during staging. Refresh the browser or accept the PWA update prompt to load the new UI. Retained assets accumulate until the next full release update.

If startup/health fails, the new service is stopped and the failed release remains selected for inspection. There is **no automatic rollback**: the new executable may already have written persistent state. After checking that the previous release can safely read the current storage, you may explicitly run:

```bash
kodex-service rollback --data-compatible
```

This swaps current/previous and starts the previous release. It never restores databases, credentials, history or project files. Incompatible storage changes require a separately planned fresh instance or other explicit policy; this tool adds no migration mechanism. Older release directories are retained, not automatically deleted. Remove only inactive releases you no longer need, after checking both symlink targets and any installed native plugin references.

Edit `~/.local/share/kodex/config.json` for subsequent starts/updates. It records the source checkout, data directory, port and explicit tool PATH. Shell profiles are not sourced by launchd. New installations omit `codex_binary`. Earlier values are ignored by the updated controller; retain the key while old controller releases remain rollback targets, since those older controllers still validate it. Native version selection now comes from the checkout schema and verified upstream package digests. The optional `environment` object accepts only the three `KODEX_VAPID_*` values, `KODEX_NOTIFICATIONS_RECHECK_DELAY_MS` and `RUST_LOG`. Configuration errors must be fixed before startup. Desktop `CODEX_HOME`, ambient API credentials and old production environment files are not inherited. Do not put secrets in the plist or commit the private configuration.

## Private HTTPS with Tailscale

Keep Kodex bound to loopback. Enable Tailscale's launch-at-login setting, then configure an unused HTTPS listener:

```bash
tailscale serve status
tailscale serve --bg --https=443 http://127.0.0.1:8787
```

Follow Tailscale's HTTPS enablement prompt if needed. Serve prints the private `https://<mac>.<tailnet>.ts.net` address. For another app already using 443, choose a different port, for example `--https=8444`; do not overwrite an existing mapping. Existing listeners on other ports are independent.

Serve persists its configuration and restores it when Tailscale starts. Kodex updates do not need a proxy restart. To remove only Kodex's mapping:

```bash
tailscale serve --https=443 off
```

Do not use `serve reset`, which removes other apps' mappings, or Funnel, which exposes a service publicly. The gateway has no authentication layer and exposes host files, terminals and account operations: restrict tailnet access to your trusted devices. See [deployment assumptions](deployment.md), [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve), and [macOS client startup limits](https://tailscale.com/docs/concepts/macos-variants). Installation and control of Tailscale itself remain independent of `kodex-service`.

## Verification

Service logic and failure paths can be tested without changing launchd or user storage:

```bash
python3 -m unittest discover -s tools/tests -p 'test_kodex_service.py'
```

These tests include a real loopback bind-conflict check, so a sandbox that prohibits socket binding must grant local network access. Live service validation additionally requires the logged-in GUI launchd domain. Installation, stop/start, update health and crash recovery should be exercised there; unit mocks alone do not establish launchd behavior.
