# Agent Instructions

This repository contains the Kodex monorepo: a Rust Codex gateway plus a planned React web frontend.

## Required Workflow

- Start every implementation change with a failing test. The test can be unit, integration, contract, or Playwright depending on the feature.
- Keep code DRY. Add shared helpers only when they remove real duplication or clarify a repeated contract.
- Follow YAGNI. Do not build features outside the active plan milestone unless the current change requires them.
- Treat generated OpenAPI as the public API contract. Public request/response DTOs live in Rust code and must generate `/openapi.json`.
- Do not create separate handwritten API contract docs unless a specific implementation issue requires explanatory prose.
- Frontend API types must come from generated OpenAPI artifacts, not ad hoc duplicate TypeScript interfaces.
- Prefer small, milestone-scoped changes that keep the repo runnable.
- Keep local/VPN-only deployment assumptions explicit. Do not imply the gateway is safe to expose publicly.

## Coding Workflow

- Work in small, reviewable chunks tied to the active milestone.
- Commit frequently at coherent boundaries, after tests pass and relevant docs are updated.
- Keep each commit focused on one sensible unit of work.
- Do not mix unrelated changes in a commit.
- Do not commit generated output, user-owned changes, or unrelated workspace changes unless they are part of the current task.
- Do not mark a milestone complete until its exit conditions are met.

## Backend Commands

- Format Rust code with `cargo fmt`.
- Run backend tests with `cargo test`.
- Start the gateway with `cargo run -p kodex-gateway`.
- Inspect generated API contract at `GET /openapi.json`; local API docs are served at `GET /docs`.
- The default database is `~/.kodex/gateway.db`; use `KODEX_DATABASE_PATH` or `KODEX_DATA_DIR` for local overrides.
- Keep the configured `codex` binary version matched to the checked-in `apps/gateway/app-server-schema/<version>/VERSION` schema version.
- Regenerate the checked-in Codex app-server JSON Schema with `apps/gateway/scripts/generate-app-server-schema.sh` after changing the Codex binary version.

## Parallel Work

- Use subagents for independent, parallelizable work when the active environment and instructions permit it.
- Give subagents bounded ownership of files, modules, or questions.
- Do not delegate work that blocks the immediate next local step.
- Avoid duplicating work between the main agent and subagents.
- Integrate and review subagent output before considering the milestone complete.

## Review Gate

- Every implementation chunk requires an independent review pass before completion.
- Prefer a review subagent when available and permitted.
- If no review subagent is available, perform a self-review and document what was checked.
- Iterate until tests pass, docs are updated, and the active milestone exit conditions are satisfied.
- Do not mark work complete while tests, docs, generated OpenAPI artifacts, generated frontend API types, or exit conditions are failing.

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
- API contract stack: Rust DTOs plus generated OpenAPI, with frontend-generated TypeScript types/client.
- Gateway talks to a configured external `codex` binary over stdio.
- Gateway serves the built frontend in production.
- SSE is the first event transport.
- WebSocket is deferred until a feature requires bidirectional browser transport.
- MVP gateway auth is omitted because deployment is localhost or trusted VPN only.
- ChatGPT/Codex auth is handled through app-server account APIs.
