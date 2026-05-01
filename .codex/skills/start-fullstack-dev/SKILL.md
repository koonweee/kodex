---
name: start-fullstack-dev
description: Start the Kodex gateway and React frontend locally for manual full-stack development, preferably using tmux so both servers keep running in separate panes.
---

# Start Full-Stack Dev

Use this skill when the user asks to run, start, restart, or explain the local Kodex full-stack development environment.

## Workflow

1. Check prerequisites if needed:
   - Rust/Cargo are available for `cargo run -p kodex-gateway`.
   - Frontend dependencies are installed with `cd apps/web && npm install`.
   - The external `codex` binary is on `PATH` when app-server readiness matters.

2. Prefer `tmux` for long-running local development:

   ```bash
   tmux new -s kodex
   ```

3. In pane 1, start the gateway:

   ```bash
   cargo run -p kodex-gateway
   ```

4. Split to pane 2 with `Ctrl-b %`, then start Vite:

   ```bash
   cd apps/web
   npm run dev
   ```

5. Open `http://127.0.0.1:5173`. Vite proxies `/v1` and `/openapi.json` to `http://127.0.0.1:8787`.

6. Useful tmux controls:
   - Detach: `Ctrl-b d`
   - Reattach: `tmux attach -t kodex`
   - Stop servers: `Ctrl-c` in each pane

## Production-Style Static Serving

Use this when the user wants to test gateway-served frontend assets instead of Vite:

```bash
cd apps/web
npm run build
cd ../..
KODEX_FRONTEND_DIST=apps/web/dist cargo run -p kodex-gateway
```

Open `http://127.0.0.1:8787`.

## Safety

Keep both setups bound to localhost or a trusted VPN. The MVP gateway has no access-control layer.
