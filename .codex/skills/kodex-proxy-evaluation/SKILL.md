---
name: kodex-proxy-evaluation
description: Evaluate a repository for compatibility with Kodex project preview proxying. Use when Codex needs to inspect frontend/backend dev server setup, detect hardcoded localhost or absolute browser API URLs, recommend relative paths or proxy-safe env changes, identify HTTP services and ports, avoid exposing databases or non-HTTP dependencies, and propose Kodex preview service, preview, route, and strip-prefix settings.
---

# Kodex Proxy Evaluation

Use this skill to produce an evaluation report for an application repo that should run behind Kodex project previews. Default to read-only analysis. Do not edit the target repo unless the user explicitly asks for patches.

## Workflow

1. Identify the app shape:
   - Read repo instructions first: `AGENTS.md`, `README*`, `CONTRIBUTING*`, setup docs, and plan files if present.
   - Inspect package/workspace files: `package.json`, `pnpm-workspace.yaml`, `yarn.lock`, `turbo.json`, `vite.config.*`, `next.config.*`, `webpack.*`, `docker-compose*.yml`, `Dockerfile*`.
   - Find start commands and ports for browser-facing services. Prefer documented commands over inferred defaults.
   - Classify non-browser services such as Postgres, Redis, queues, object stores, and mailcatchers as internal dependencies unless they expose an HTTP UI the user wants to preview.

2. Inspect browser-facing API configuration:
   - Search for `localhost`, `127.0.0.1`, `0.0.0.0`, absolute `http://` or `https://` API bases, `VITE_`, `NEXT_PUBLIC_`, `REACT_APP_`, `PUBLIC_`, `API_URL`, `BASE_URL`, `axios.create`, `fetch(`, `ky.create`, GraphQL clients, generated API clients, and websocket URLs.
   - Distinguish server-only environment variables from browser-exposed values. Browser-exposed localhost values are usually proxy-breaking.
   - Prefer relative browser API paths such as `/api/...` when the frontend and backend should be reached through one Kodex preview origin.
   - Preserve absolute URLs only when they intentionally target a third-party service or a separately exposed public origin.

3. Inspect backend routing:
   - Identify whether the backend serves routes under a prefix such as `/api`.
   - For NestJS, check `main.ts` for `app.setGlobalPrefix(...)` and CORS setup.
   - For Express/Fastify/Koa/Rails/Laravel/Django/etc., inspect router mounting and configured prefixes.
   - Use this to decide Kodex route `stripPrefix`: off when the backend expects `/api/...`; on when the frontend calls `/api/...` but the backend expects `/...`.

4. Propose minimal repo changes:
   - Recommend changing browser-facing hardcoded local origins to relative paths or environment defaults that are relative in development preview mode.
   - Recommend keeping backend-to-database and backend-to-service URLs as internal localhost/container-network settings when appropriate.
   - Mention CORS only when cross-origin direct browser calls remain necessary. A single-origin Kodex preview with relative `/api` calls should usually not need browser CORS changes.
   - If websocket/SSE endpoints exist, recommend relative or same-origin URL construction and note whether the current Kodex preview route can proxy them.

5. Propose Kodex preview settings:
   - Create one service per local HTTP app: name, protocol `http`, local port, health path.
   - Create one preview rooted at the frontend service when there is a browser frontend.
   - Add path routes from the frontend preview to backend HTTP services, usually `/api/*`.
   - Do not propose database ports or non-HTTP dependencies as preview services.
   - Note a likely public port, but let Kodex allocate it when no fixed port is required.

## Report Format

Use this structure in the final answer:

```markdown
## Repo Shape
- Frontend: <cwd>, <start command>, <port>
- Backend: <cwd>, <start command>, <port>
- Internal dependencies: <db/cache/etc. and ports>

## Browser URL Risks
- <file:line>: <risk and why it breaks behind a preview>
- None found.

## Suggested Repo Changes
- <minimal change>
- No repo changes appear required.

## Kodex Preview Settings
Services:
- <Name>: protocol http, local port <port>, health path <path>

Preview:
- Name: App
- Root service: <Frontend>
- Public port: <let Kodex allocate or chosen port>

Routes:
- /api/* -> <Backend>, stripPrefix <on/off>, because <reason>

## Start Order
1. Start internal dependencies.
2. Start backend service(s).
3. Start frontend service.
4. Open the Kodex preview URL.
```

Omit empty sections only when they genuinely do not apply. Include concrete file references for risks and proposed code changes when possible.

## Heuristics

- Vite default port is often `5173`, but prefer configured or documented ports.
- Next.js default port is often `3000`, but check scripts and env.
- NestJS often uses `3000`; `app.setGlobalPrefix("api")` means route `/api/*` should usually keep `stripPrefix` off.
- A frontend dev server proxy in Vite/Next/Webpack may be adequate locally, but Kodex preview settings should still route browser requests through the preview origin.
- If the frontend and backend are separate repos or commands but the frontend uses relative `/api`, root the preview at the frontend and route `/api/*` to the backend.
- If the app has only a backend HTTP API and no frontend, propose a preview rooted at that backend and do not invent a frontend service.
- If the app has multiple frontends, propose one preview per user-facing frontend unless the repo clearly expects one shell app to own routing.
- Treat `localhost` inside server-side backend config as acceptable when it targets local infrastructure such as Postgres. Treat `localhost` inside browser bundles or public env as suspect.

## Safety

Keep Kodex previews scoped to localhost or trusted VPN/tailnet use. Do not imply gateway previews are safe for public internet exposure. Do not suggest exposing Postgres, Redis, Docker daemon ports, or other private infrastructure through Kodex previews.
