# Kodex Control

Kodex Control is a required part of each Kodex-managed runtime. The gateway registers its MCP server and installs its bundled skills before starting app-server. There is no plugin installation or Preferences install panel.

## Runtime bundle

Skills live in `runtime/kodex/skills` and are embedded in the gateway through the explicit inventory in `apps/gateway/src/app_server/builtin.rs`. Add or remove inventory entries alongside skill files. Rebuild the gateway to update the bundle; no cachebuster, marketplace or separate skill version is needed.

Managed startup reconciles owned files under the dedicated `CODEX_HOME/skills/kodex-builtin`. A small receipt records ownership. Retired bundled files are removed; unrelated user skills and added files are preserved. Ownership collisions and symlinked bundle paths fail startup rather than overwrite user content. Update/restart and rollback to a release with this mechanism reconcile that release's embedded bundle. Frontend-only updates do not modify it.

MCP configuration is launch-scoped and does not edit user configuration. The `mcp_servers.kodex-control` name is reserved: a manual definition in the dedicated home configuration or `KODEX_CODEX_ARGS` fails startup with instructions to rename or remove that entry. Native overrides merge tables, so silently accepting it could retain foreign transport settings. The old `kodex-control@kodex-local` plugin is disabled for managed launches to avoid duplicate tools; its installation is left intact for rollback. This does not uninstall or change any plugin listing in external accounts. Rollback to a release predating built-in Control uses that release's old plugin setup; the new prefixed skill may remain on disk until a built-in release starts again.

## MCP server

The gateway binary hosts the built-in MCP server:

```bash
kodex-gateway mcp kodex-control
```

Managed Kodex launches provide the actual bound gateway URL and running executable to their own Codex child through `KODEX_GATEWAY_URL` and `KODEX_GATEWAY_BINARY`. The built-in registration forwards these native `env_vars` to the MCP process. This supports an ephemeral or custom port and avoids an HTTP bootstrap lookup, a Cargo build, or accidentally invoking another installed gateway. Inherited Control bindings are stripped before setting the owned values. Wildcard listeners use loopback; a specific private/VPN listener also receives the child-only remote opt-in required to reach that address. This does not make the gateway safe for public exposure.

Normal source-checkout gateway launches use the same setup as the installed service. Direct MCP invocations can set `KODEX_GATEWAY_URL`; otherwise the server defaults to `http://127.0.0.1:8787`. Non-loopback URLs require `KODEX_ALLOW_REMOTE_SELF_CONTROL=1`.

The server exposes guarded tools for:

- Gateway status.
- Thread creation and input.
- Generated app surfaces.
- Automation management.

It also exposes resources such as `kodex://status`, `kodex://projects`, `kodex://threads/{threadId}/app-surface`, and `kodex://automations`.

## Thread creation and archives

`create_thread` and `spawn_thread` accept an optional `projectId`. With a project, `cwd` must match its sole root. Without a project, an absolute `cwd` is accepted; omitting it creates a unique `Chat` directory under `~/Documents/Codex/<date>`, following the standalone chat policy. Creation never guesses project membership. Spawn retains its guarded admission receipt: reuse the same key after an uncertain acknowledgment rather than retrying with a new key.

`list_threads` defaults to active threads. Set `archived: true` for archived threads, optionally filtering by project and paginating with the native cursor. Archived pages default to 50 entries and accept limits from 1 to 100. `unarchive_thread` restores a thread through the native runtime without submitting input. Existing sidebar refill events notify other clients; reconnects read native membership again.

## Chat notifications

`set_thread_notifications(threadId, enabled)` changes the existing whole-chat push preference. It affects both manual and automated turns, persists in the gateway, and publishes the same notification-setting event used by browser controls. Reads through existing thread tools expose `notificationsEnabled`. This does not request device permission, change push subscriptions, or provide a failed-automation-runs-only filter. No preference is encoded in an automation prompt.

## Compact turn reads

`get_compact_turns` reads one native history page, newest turns first. Pass `nextCursor` back as `cursor` for older turns. It does not resume a chat, start inference, update read receipts or store summaries. A failed native read is an error, never empty history; a concurrent revert rejects an obsolete response so the caller can read again.

The default is five turns and 16,000 Unicode characters of excerpt text. `limit` accepts 1–20 and `maxChars` accepts 256–64,000. Each text field is capped at 4,000 characters, with at most 200 items across the page. `truncated` and `omittedItems` identify shortened results; this is an excerpt rather than an exhaustive transcript. IDs, item types, turn/tool status, exit codes and failure messages remain structured. User and assistant text is included; tool output text requires `includeToolOutput: true`. Binary media, tool arguments and opaque result/config payloads are not returned.

## Multi-thread waiting

`wait_threads` accepts 1–8 distinct `{threadId, afterCursor?}` targets. It observes the newest native turn and native attention state without resuming chats, reading full history, changing queues or marking results seen. An empty idle chat is not a completion. A first call returns an already-completed latest turn; a chat still reported active does not deliver an older answer as current work.

The default wait is 30 seconds, with `timeoutMs` from 0 to 60,000. Zero performs one snapshot attempt. Observations use at most eight concurrent target reads, eight headers per target and a 500 ms fallback interval; relevant events can shorten that interval to 250 ms. Commentary and unrelated events do not trigger matches or extra reads. Snapshot and progress phases each have a five-second bound, so fetching snapshots can add up to ten seconds beyond the event-wait duration. Return progress is one compact turn per target, capped at 8,000 text characters with the compact reader's field/item bounds. No inference or background wait service is involved.

Return each target's `cursor` as `afterCursor` on later calls. The cursor is an opaque observation receipt, not a read acknowledgment or a durable subscription. A current receipt omits already-delivered terminal items, including across intervening active snapshots. `reset: true` signals a gateway runtime change or observed history revert; the returned state is a fresh baseline, not proof of a newly completed turn. Different retained history after a reset can appear in that baseline. Cursors belong to one thread.

`status` is `matched`, `timeout` or `error`; every successful target has current state/progress, and failures appear separately in `errors`. Native waiting-on-approval/user-input flags, system errors, and pending gateway approval requests are attention conditions. Attention receipts include every outstanding request up to 64 IDs; above that bound, the target returns an explicit error directing the caller to `list_approvals`. Approval payloads are not loaded by waiting. Transient native catch-up and snapshot overlap are re-observed within the deadline, then reported as retryable if still unresolved.

MCP cancellation ends the tool call and drops its HTTP request. Dropping a gateway wait future drops its subscription and aborts its request-scoped child reads. Transport disconnect detection may lag; any surviving HTTP handler still expires under the bounds above. New user input does not itself cancel this tool, and it does not reproduce desktop-specific user-input wake behavior.

## App surfaces

Generated app surfaces let Codex open or update temporary, thread-bound HTML when direct interaction is clearer than chat. They should:

- Adapt to desktop split panes and mobile full-height sheets.
- Include useful fallback content.
- Request bridge grants explicitly.
- Keep embedded-data interactions such as tabs, filters, charts, and modals inside the iframe.
- Use `ui/message` only when an action needs Codex, tools, persistence, continued workflow, or an explicit user decision.

MCP tool and resource calls pass through gateway-owned grants and inherit Kodex's localhost/private-network security model. Generated-provider MCP tool calls also require user approval for the exact requested arguments and metadata before execution. Hosted MCP apps retain the app/account scope validated by their originating native call. Every app-surface tool requires an explicit Kodex chat ID; foreign MCP metadata cannot supply one. External network access remains denied unless an explicit future policy grants it.

## Example use

A Kodex chat can invoke the bundled skill with a prompt such as:

```text
Use $kodex-generative-ui to create an interactive app surface for exploring these options.
```
