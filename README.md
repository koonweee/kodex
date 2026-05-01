# Kodex

Kodex is a local-first or VPN-only Codex gateway and web app built from scratch in a monorepo.

The MVP target is a Rust gateway that supervises an external `codex app-server` process over stdio, persists and replays events, brokers approvals, and serves a React web client. The web client is intentionally replaceable later by another client.

## Current Status

Planning only. See [plans/index.md](plans/index.md) for the plan directory and status table.

## MVP Assumptions

- Backend: Rust with `axum`, `tokio`, `sqlx`, and SQLite WAL.
- Frontend: React, Vite, and TypeScript.
- Codex integration: configurable external `codex` binary over stdio.
- Deployment: localhost or trusted VPN only.
- Gateway auth: none for MVP. Do not expose directly to the public internet.
- OpenAI/Codex auth: handled through Codex app-server account APIs.
- Streaming: SSE first, with WebSocket deferred until terminal or realtime requirements need it.
- Production packaging: gateway serves built React assets from the same binary or static directory.
- API contract: generated OpenAPI from Rust DTOs, served by the gateway, consumed by the frontend.

## Development Rules

- Write a failing test before implementation.
- Keep implementation DRY.
- Apply YAGNI: do not add multi-user auth, Redis, Postgres, plugin UI, automations, or public SaaS concerns until required.
- Keep API contracts source-of-truth in backend code. Do not maintain separate handwritten request/response docs.
- Update `AGENTS.md`, `README.md`, and `plans/index.md` whenever behavior, commands, plan status, or project conventions change.

## Planned Documents

- [MVP backend implementation plan](plans/mvp-backend.md)
- [MVP frontend implementation plan](plans/mvp-frontend.md)
- [Future extensions overview](plans/future-extensions.md)
