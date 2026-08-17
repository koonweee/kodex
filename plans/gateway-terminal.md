# Gateway Terminal Plan

## Status

Complete. Implemented a gateway-host terminal surface, enabled by default under Kodex's existing localhost/trusted-VPN deployment assumption. The implementation keeps trigger placement and terminal render placement decoupled so the launcher can move out of the sidebar header and the terminal can move out of the initial dock/sheet host later.

## Goal

Let the web UI open an interactive shell on the same host where `kodex-gateway` is running. The first version should provide a global gateway terminal launcher near the workspace sidebar search/new-thread controls, then render the terminal in a shell-owned bottom dock on desktop and a touch-friendly bottom sheet on narrow/touch devices.

The feature is intentionally local-gateway scoped. It is not a remote server manager, not a project preview proxy, and not a replacement for Codex app-server command execution inside agent turns.

## Settled Product Decisions

- Terminals are enabled by default. Kodex already assumes localhost or trusted VPN deployment, and v1 should not hide the feature behind an opt-in flag.
- The terminal target is the gateway host only. No remote server registry or multi-node control-plane split.
- The first visible trigger is a terminal icon button in the workspace sidebar header beside search and the new chat/new thread action.
- The terminal render area is shell-level, not nested in `WorkspaceSidebar`, so the trigger and host can move independently later.
- Desktop renders a bottom-docked terminal panel over the main shell workspace.
- Narrow/touch renders the same terminal host as a tall bottom sheet with explicit mobile controls.
- The v1 shell starts in a gateway-chosen default cwd, with API room for future trigger-provided cwd such as a project cwd.
- The feature must preserve generated OpenAPI discipline for HTTP routes. The websocket byte protocol is not an OpenAPI surface and should be covered by focused code tests plus short implementation comments.
- The implementation must keep local/VPN-only shell access explicit in README and avoid public-exposure claims.

## Non-Goals

- No remote host management.
- No SSH client UI.
- No project-specific launcher in v1, though the backend and frontend props should allow adding one later.
- No durable terminal history across gateway restarts in v1.
- No terminal transcript in thread timelines.
- No app-server protocol changes.
- No gateway auth model redesign.
- No plugin or MCP exposure in v1.

## Current Kodex Grounding

Backend:

- Public route registration and OpenAPI live in `apps/gateway/src/api.rs`, specifically `build_router`.
- Route modules live under `apps/gateway/src/routes/` and are merged through `apps/gateway/src/routes/mod.rs` plus `apps/gateway/src/api.rs`.
- Current SSE routes are in `apps/gateway/src/routes/events.rs` and `apps/gateway/src/events.rs`; terminal I/O should not use this event stream.
- `apps/gateway/Cargo.toml` currently uses `axum = { version = "0.8", features = ["macros", "multipart"] }`, so websocket support requires adding the `ws` feature.
- `apps/gateway/Cargo.toml` already enables `tokio` process and io features, but no PTY crate is present.
- Gateway config lives in `apps/gateway/src/config.rs`. Existing defaults include `server.trusted_network_only = true`, `projects.home_dir`, and local/VPN-oriented preview config.
- App-server process management in `apps/gateway/src/app_server.rs` is not the right terminal seam. The terminal should be gateway-owned and independent of Codex app-server lifecycle.

Frontend:

- `apps/web/src/threads/WorkspaceSidebar.tsx` owns the sidebar search and new-chat/header controls. It is the right initial trigger location.
- `apps/web/src/shell/KodexShellView.tsx` owns the top-level shell layout and already hosts cross-cutting surfaces such as preferences and generated UI.
- `apps/web/src/App.tsx` is the shell coordinator. It should hold only high-level terminal host state and pass trigger/render props down; terminal runtime behavior should live in a feature module.
- `apps/web/src/generatedUi/GeneratedUiPane.tsx` and `apps/web/src/shell/useGeneratedUiResize.ts` are useful precedents for feature-owned panes with shell-level placement and responsive host behavior.
- `apps/web/src/api/client.ts` wraps generated OpenAPI types. New terminal HTTP types should come from `apps/web/src/api/generated/schema.ts`.
- `apps/web/package.json` currently has no xterm dependencies. Add `@xterm/xterm` and `@xterm/addon-fit`; only add a React wrapper if it materially reduces local complexity.

Planning and workflow:

- `AGENTS.md` requires behavior-changing implementation work to start with failing tests when practical.
- Frontend behavior belongs in feature modules, hooks, reducers, or domain components rather than growing `App.tsx`.
- Responsive changes must separate viewport width from input modality and test desktop fine pointer, narrow fine pointer, and narrow touch/mobile shapes when both layout and input modality matter.
- Browser-observable UI work should include `$agent-browser` validation.

## Architecture Direction

### Backend Terminal Runtime

Add a gateway-owned terminal module, for example `apps/gateway/src/terminal.rs`, with these seams:

- `TerminalManager`
  - Creates, lists, attaches to, resizes, and terminates in-memory sessions.
  - Owns a bounded session map keyed by generated session id.
  - Tracks session metadata for HTTP list/get responses.
  - Cleans up exited sessions and closed sessions.
- `TerminalSession`
  - Owns PTY child process, stdin sender, stdout broadcast channel, resize handling, created/updated timestamps, cwd, command, and exit status.
  - Keeps a bounded rolling output buffer for reconnect while the gateway process is alive.
- `TerminalMessage`
  - Encodes browser-to-gateway websocket messages.
  - Use a tiny binary framing model: stdin bytes, resize payload, and an optional begin/control message.
  - Keep framing helpers pure and unit-tested.

Use `portable-pty` unless implementation discovery finds a better maintained Rust PTY fit. Avoid plain `tokio::process::Command` for the interactive shell because it will not provide proper TTY behavior for full-screen TUIs, signals, terminal size, or line editing.

Default cwd should be `Config.projects.home_dir` when no cwd is provided. HTTP session creation should accept an optional cwd so future project-row triggers can pass a project cwd without changing the terminal runtime.

### Backend HTTP And Websocket API

Add `apps/gateway/src/routes/terminals.rs` and register it in `apps/gateway/src/api.rs`.

HTTP routes:

- `GET /v1/terminals`
  - Lists active terminal sessions and metadata.
- `POST /v1/terminals`
  - Creates a session.
  - Request fields: optional `cwd`, optional `command`, optional `title`.
  - Defaults: `cwd = projects.home_dir`, `command = user's shell or a conservative platform default`.
- `DELETE /v1/terminals/{terminalId}`
  - Terminates and removes a session.

Websocket route:

- `GET /v1/terminals/{terminalId}/ws`
  - Streams PTY output to the browser.
  - Forwards browser stdin and resize messages to the PTY.
  - Replays in-memory rolling output after connection.
  - Does not appear in OpenAPI except as a route note in code comments, because OpenAPI does not describe the byte stream contract.

DTOs:

- Define public request/response structs in Rust and add them to `ApiDoc`.
- Regenerate `apps/web/src/api/generated/schema.ts`.
- Add wrappers in `apps/web/src/api/client.ts`, including a helper to build the websocket URL from the current API base.

Capabilities:

- Add a capability field to the existing `GET /v1/capabilities` response, for example `terminals: { enabled: true }`, so the UI can avoid rendering a broken launcher if a future config or platform limitation disables terminals.
- v1 should report enabled by default. If PTY initialization fails at session creation, show the error in the terminal host.

### Frontend Terminal Feature Module

Add a new feature directory, for example `apps/web/src/terminal/`, with:

- `GatewayTerminalLauncher.tsx`
  - A small trigger component with no knowledge of where the terminal renders.
  - Props: `onOpen`, `disabled`, optional `active`.
  - Used initially by `WorkspaceSidebar`.
- `GatewayTerminalHost.tsx`
  - Shell-level host for desktop dock and mobile sheet.
  - Props: `opened`, `onClose`, optional `initialCwd`, optional `triggerLabel`.
  - Owns session selection/create behavior through a hook.
- `GatewayTerminalPane.tsx`
  - Pure terminal pane chrome: title, cwd/status, close, restart/new session, kill session, and error area.
  - Receives terminal runtime props rather than owning launcher placement.
- `XtermTerminal.tsx`
  - xterm integration only.
  - Owns `Terminal`, `FitAddon`, websocket attach/detach, stdin forwarding, binary output writes, and resize messages.
- `useGatewayTerminalSession.ts`
  - Creates/list sessions through HTTP wrappers and attaches to websocket.
  - Keeps browser-only open/focus state separate from gateway session state.
- `terminalProtocol.ts`
  - Browser-side encode/decode helpers matching backend framing.
  - Unit-testable without rendering xterm.

Keep `App.tsx` to high-level state only:

- `const [gatewayTerminalOpen, setGatewayTerminalOpen] = useState(false)`
- Pass `onGatewayTerminalOpen` into `WorkspaceSidebar`.
- Pass `gatewayTerminalProps` into `KodexShellView`.

Keep `WorkspaceSidebar.tsx` trigger-only:

- Add `onOpenGatewayTerminal?: () => void`.
- Add `gatewayTerminalAvailable?: boolean`.
- Render the terminal launcher in the header action group only when available.
- Do not import xterm, websocket code, or terminal session hooks into `WorkspaceSidebar`.

Keep `KodexShellView.tsx` host-only:

- Add `gatewayTerminalHost?: ReactNode` or typed `gatewayTerminalProps`.
- Render the host as a sibling of `AppShell.Main`, similar to preferences/generated UI cross-cutting surfaces.
- The terminal host must not depend on sidebar internals.

### UX Contract

Desktop:

- Sidebar header order: search input, terminal icon, new-chat/new-thread icon.
- Use a lucide terminal-style icon, for example `SquareTerminal`, with tooltip and accessible label "Open gateway terminal".
- Bottom dock height defaults to about `40dvh`, with min about `220px` and max about `75dvh`.
- Dock should have stable dimensions so xterm fit calls do not cause layout jumps.
- Header controls should include close and a clear terminal/session status. Keep controls icon-first with tooltips.

Mobile and touch:

- Render as a bottom sheet rather than squeezing into the sidebar.
- Height should be tall, about `85dvh`, safe-area aware, and refit xterm on open, visual viewport resize, orientation change, and sheet size changes.
- Include an accessory key row with at least `Esc`, `Tab`, `Ctrl`, arrow keys, and paste if feasible.
- Touch controls must meet the existing touch density guidance: 44px targets on coarse/touch devices.
- Touch users must have an explicit close path and must not rely on hover controls.

Focus and lifecycle:

- Opening the terminal focuses xterm after the websocket is attached and fit has run.
- Closing the dock/sheet hides the host but does not necessarily kill the session.
- Add an explicit kill/delete control for the session.
- Reopening should reconnect to the existing active session when possible.
- If the websocket closes unexpectedly, show a reconnectable error state without crashing the shell.

## Milestones

### 1. Backend PTY Runtime And Protocol

Scope: `apps/gateway/Cargo.toml`, new `apps/gateway/src/terminal.rs`, focused backend tests.

Work:

- Add `portable-pty` and any small support dependencies required for PTY management.
- Implement `TerminalManager`, `TerminalSession`, bounded session metadata, rolling output buffer, and cleanup of exited sessions.
- Implement pure browser-to-gateway terminal message framing helpers for stdin, resize, and control messages.
- Start with failing unit tests for message framing and session metadata behavior.
- Add tests for default cwd selection using `Config.projects.home_dir`.

Exit criteria:

- Focused `cargo test terminal` or equivalent backend tests pass.
- PTY framing tests cover valid stdin, valid resize, empty/invalid messages, and unknown control bytes.
- Runtime tests do not require a long-lived real shell when a fake seam is practical; any real shell smoke must be bounded and platform-tolerant.

### 2. Backend Routes, OpenAPI, And Websocket

Scope: `apps/gateway/src/routes/terminals.rs`, `apps/gateway/src/api.rs`, `apps/gateway/src/routes/mod.rs`, `apps/gateway/src/config.rs` if needed, `apps/gateway/src/routes/capabilities.rs`, generated OpenAPI.

Work:

- Add terminal HTTP DTOs and register them in `ApiDoc`.
- Add `GET /v1/terminals`, `POST /v1/terminals`, and `DELETE /v1/terminals/{terminalId}`.
- Add `GET /v1/terminals/{terminalId}/ws` using `axum` websocket support.
- Wire websocket attach, output replay, stdin forwarding, resize forwarding, close cleanup, and explicit delete.
- Add `terminals.enabled` to capabilities, defaulting to true.
- Ensure route errors clearly distinguish missing session, PTY spawn failure, invalid cwd, and invalid websocket frame.
- Keep the trusted-local deployment assumption visible in route docs/comments where shell access is introduced.

Exit criteria:

- Backend route tests cover create/list/delete, invalid cwd, and missing terminal id.
- Websocket tests cover at least protocol-level handler behavior or a bounded integration shape where feasible.
- `cargo fmt` and focused `cargo test` pass.
- `/openapi.json` includes the HTTP terminal DTOs/routes.

### 3. Frontend API And Encapsulated Terminal Components

Scope: `apps/web/package.json`, `apps/web/src/api/generated/schema.ts`, `apps/web/src/api/client.ts`, new `apps/web/src/terminal/`.

Work:

- Add xterm dependencies.
- Regenerate frontend OpenAPI types after the gateway route exists.
- Add generated-type-backed API wrappers for list/create/delete terminal sessions and a websocket URL helper.
- Implement `terminalProtocol.ts` with unit tests matching backend framing.
- Implement `XtermTerminal.tsx` with xterm lifecycle isolated from shell/sidebar components.
- Implement `useGatewayTerminalSession.ts` for HTTP session lifecycle and websocket attach/detach.
- Implement `GatewayTerminalPane.tsx` and `GatewayTerminalHost.tsx` without importing sidebar code.

Exit criteria:

- `apps/web/src/terminal/terminalProtocol.test.ts` covers stdin, resize, and invalid framing.
- Component tests cover create-on-open, close-without-delete, delete/kill action, websocket close error, and reconnect path using mocked websocket.
- `cd apps/web && npm test` focused terminal suites pass.

### 4. Shell Integration And Trigger Placement

Scope: `apps/web/src/App.tsx`, `apps/web/src/shell/KodexShellView.tsx`, `apps/web/src/threads/WorkspaceSidebar.tsx`, `apps/web/src/styles/sidebar.css`, `apps/web/src/styles/shell.css`.

Work:

- Add high-level terminal open state in `App.tsx` only.
- Pass `onOpenGatewayTerminal` and availability into `WorkspaceSidebar`.
- Add a sidebar header action group so search, terminal, and new-chat/new-thread controls have stable sizing.
- Render `GatewayTerminalHost` from `KodexShellView` as a shell-level surface.
- Add desktop bottom dock styling and mobile/touch bottom sheet styling.
- Refit xterm when the host opens, resizes, switches viewport mode, or receives `visualViewport` changes.
- Keep all xterm and websocket implementation details out of `WorkspaceSidebar` and `KodexShellView`.

Exit criteria:

- Sidebar tests cover the terminal launcher placement and callback without depending on terminal internals.
- Shell/component tests verify the host renders independently from the sidebar trigger.
- Existing sidebar responsive and reorder tests still pass.
- `cd apps/web && npm test` focused sidebar/shell/terminal suites pass.

### 5. Documentation, Verification, And Browser QA

Scope: `README.md`, `AGENTS.md` only if workflow/security guidance changes, `plans/index.md`, browser validation.

Work:

- Update README to mention the gateway terminal, local/VPN-only trust boundary, and any relevant env/config defaults.
- Keep `AGENTS.md` unchanged unless implementation introduces new contributor workflow rules.
- Update this plan status as milestones are implemented.
- Use `$agent-browser` for UI validation after implementation.

Exit criteria:

- `cargo fmt`
- Focused `cargo test` for terminal backend routes/runtime.
- `cd apps/web && npm test` focused terminal/sidebar/shell suites.
- `cd apps/web && npm run build`.
- `$agent-browser` validates:
  - desktop fine pointer: sidebar launcher opens bottom dock, shell is usable, close/reopen preserves session, delete kills session.
  - narrow fine pointer: layout does not overlap and terminal remains usable.
  - narrow touch/mobile shape: bottom sheet opens, accessory key row is reachable, visual viewport/keyboard resizing does not hide terminal controls.
  - console has no runtime errors during open, resize, close, reconnect, and delete.

## Encapsulation Guardrails

- `WorkspaceSidebar` may import only the launcher component or receive a rendered trigger prop. It must not import xterm, websocket helpers, or terminal session hooks.
- `KodexShellView` may render the terminal host but must not own terminal protocol or session behavior.
- `App.tsx` may own only open/close state and capability-derived availability.
- `apps/web/src/terminal/` owns terminal UI, xterm integration, session hooks, protocol helpers, and feature tests.
- `apps/gateway/src/terminal.rs` owns PTY runtime and protocol helpers.
- `apps/gateway/src/routes/terminals.rs` owns HTTP/websocket adapters only.
- Trigger props should accept optional context such as `cwd` so a future project-row trigger can open the same terminal host without rewriting the runtime.
- Render host props should be placement-neutral enough to move from bottom dock to side pane, tab, drawer, or command-palette-launched surface later.

## Risks And Open Questions

- PTY crate portability: `portable-pty` is the leading candidate, but implementation should verify macOS/Linux behavior before broad tests depend on specific shell output.
- Shell command default: using the user's `SHELL` is ergonomic on Unix, but tests should avoid assuming a particular shell. Fallback should be explicit.
- Mobile text input: xterm on mobile is serviceable but rough. The accessory key row and visual viewport resize handling are required for v1 quality.
- Multi-tab behavior: terminal session state lives in the gateway while open state is browser-local. Two tabs attaching to the same session should both see output if they choose the same session, but v1 does not need shared dock visibility.
- Security posture: enabled-by-default shell access is acceptable only within the existing localhost/trusted-VPN assumption. Any future public/authenticated deployment changes must revisit this feature.
