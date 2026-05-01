# Agent Instructions

This repository is planning the Kodex monorepo: a Rust Codex gateway plus a React web frontend.

## Required Workflow

- Start every implementation change with a failing test. The test can be unit, integration, contract, or Playwright depending on the feature.
- Keep code DRY. Add shared helpers only when they remove real duplication or clarify a repeated contract.
- Follow YAGNI. Do not build features outside the active plan milestone unless the current change requires them.
- Prefer small, milestone-scoped changes that keep the repo runnable.
- Keep local/VPN-only deployment assumptions explicit. Do not imply the gateway is safe to expose publicly.

## Documentation Discipline

- Keep [plans/index.md](plans/index.md) up to date whenever a plan status changes.
- Update `README.md` when setup, commands, security assumptions, or project structure change.
- Update this `AGENTS.md` when contributor workflow, testing rules, or project constraints change.
- If implementation details diverge from a plan, update the relevant plan before or in the same change.

## Plan References

- Backend MVP: [plans/mvp-backend.md](plans/mvp-backend.md)
- Frontend MVP: [plans/mvp-frontend.md](plans/mvp-frontend.md)
- Future extensions: [plans/future-extensions.md](plans/future-extensions.md)

## Initial Architecture Constraints

- Monorepo from scratch.
- Backend stack: Rust, `axum`, `tokio`, `sqlx`, SQLite WAL.
- Frontend stack: React, Vite, TypeScript.
- Gateway talks to a configured external `codex` binary over stdio.
- Gateway serves the built frontend in production.
- SSE is the first event transport.
- WebSocket is deferred until a feature requires bidirectional browser transport.
- MVP gateway auth is omitted because deployment is localhost or trusted VPN only.
- ChatGPT/Codex auth is handled through app-server account APIs.

