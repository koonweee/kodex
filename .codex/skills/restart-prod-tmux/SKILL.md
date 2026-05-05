---
name: restart-prod-tmux
description: Rebuild the Kodex production frontend bundle and restart the localhost production tmux session (`kodex-prod`) so the gateway serves the latest local backend and frontend code.
---

# Restart Prod Tmux

Use this skill when the user asks to rebuild or restart the production-style Kodex tmux session that serves the built frontend from the Rust gateway.

## When To Use It

- The user asks to restart `kodex-prod`, "prod tmux", or the production-style local server.
- The user wants backend and frontend running on the latest local workspace changes.
- The user wants verification that the local production endpoint is responding after restart.

## Workflow

1. Work from the repo root.
2. Rebuild the frontend bundle:

   ```bash
   cd apps/web
   npm run build
   ```

3. Restart the tmux production session with the latest local code. Prefer the bundled script for consistent behavior:

   ```bash
   .codex/skills/restart-prod-tmux/scripts/restart-prod.sh
   ```

4. Verify the result:
   - `tmux ls` shows `kodex-prod`
   - `lsof -nP -iTCP:8787 -sTCP:LISTEN` shows `kodex-gateway`
   - `curl -I http://127.0.0.1:8787` returns `200 OK`

## Notes

- The production-style session is a single tmux session where the gateway serves `apps/web/dist`; there is no separate long-running frontend dev server in this mode.
- Restart against the current local workspace state unless the user explicitly asks to pull from remote.
- `tmux` and direct localhost verification may require execution outside the sandbox.

## Safety

Keep this setup on localhost or a trusted VPN only. The MVP gateway has no access-control layer.
