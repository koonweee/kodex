---
name: restart-prod-tmux
description: Rebuild the Kodex production frontend bundle and restart the localhost production tmux session (`kodex-prod`) so the gateway serves the latest local backend and frontend code. Require user approval before running the restart unless the user explicitly invokes this skill or explicitly asks to restart `kodex-prod`/prod tmux.
---

# Restart Prod Tmux

Use this skill when the user asks to rebuild or restart the production-style Kodex tmux session that serves the built frontend from the Rust gateway.

## When To Use It

- The user asks to restart `kodex-prod`, "prod tmux", or the production-style local server.
- The user wants backend and frontend running on the latest local workspace changes.
- The user wants verification that the local production endpoint is responding after restart.

## Workflow

1. Work from the repo root.
2. Apply the approval gate before running any restart, tmux, build, or localhost verification command:
   - If the user explicitly invoked this skill, explicitly said to restart `kodex-prod`/prod tmux, or directly asked for the production-style session to be restarted, proceed without an additional approval prompt.
   - If the skill was loaded because restarting might be useful after another task, ask the user for approval before continuing. Do not run the restart script or related tmux/build/verification commands until the user approves.
3. Restart the tmux production session with the latest local code. Prefer the bundled script for consistent behavior:

   ```bash
   .codex/skills/restart-prod-tmux/scripts/restart-prod.sh
   ```

   The script always hands off the rebuild/restart work to a separate temporary tmux session, `kodex-prod-restart`, before returning. This makes it safe to invoke from inside the existing `kodex-prod` session.

4. Verify the result:
   - `/tmp/kodex-prod-restart.log` shows the child process completed the frontend build and endpoint check
   - `tmux ls` shows `kodex-prod`
   - `lsof -nP -iTCP:8787 -sTCP:LISTEN` shows `kodex-gateway`
   - `curl -I http://127.0.0.1:8787` returns `200 OK`

## Notes

- The production-style session is a single tmux session where the gateway serves `apps/web/dist`; there is no separate long-running frontend dev server in this mode.
- The restart script rebuilds the frontend bundle itself; do not run a separate frontend build first unless you are intentionally checking build failures before restart.
- The restart script returns after handoff, so follow up by polling `/tmp/kodex-prod-restart.log`, `tmux`, and the endpoint instead of treating the script exit code as final restart success.
- The temporary handoff session defaults to `kodex-prod-restart` and exits when the child process finishes.
- Restart against the current local workspace state unless the user explicitly asks to pull from remote.
- `tmux` and direct localhost verification may require execution outside the sandbox.

## Safety

Keep this setup on localhost or a trusted VPN only. The MVP gateway has no access-control layer.
