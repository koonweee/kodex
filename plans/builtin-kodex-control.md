# Built-in Kodex Control

Status: Complete

## Outcome

Kodex Control is a required part of every Kodex-managed runtime, not an opt-in plugin. Keep the existing MCP server, gateway self-control policy and generated app behavior. Bundle Kodex-owned skills with the application and remove the Control installation UI and plugin distribution machinery.

## Design constraints

- Prefer existing native MCP configuration and skill discovery. Verify the pinned generated schemas and upstream app-server README before integration changes.
- One shared setup path before managed app-server launch covers installed service and development launches. Release packaging supplies the matching assets; no separate updater, marketplace, per-skill versions or background reconciliation service.
- Prefer launch-scoped MCP configuration if the pinned runtime supports it reliably, avoiding persistent user-config edits. Bind to this instance and its gateway binary using existing control binding.
- Maintain a small explicit bundle inventory; add ownership metadata only where required to safely remove retired skills. Preserve unrelated files, configuration and user skills. Reject ownership collisions rather than overwrite them.
- Keep updates repeatable and recoverable. Match skills to the running release on restart/update/rollback; frontend-only updates do not change runtime assets. Verify skill discovery supports the chosen directory layout.
- Remove/disable only the old Kodex Control plugin using supported native mechanisms, preventing duplicate registration. Do not touch other plugins, desktop homes or external accounts. Do not promise removal of remotely synchronized listings.
- No changes to tool behavior, queue routing, approval policy, transcript ownership or generated app contracts. No live deployment or production restart in this scope.

## Implementation sequence

1. Verify native MCP overrides, skill discovery and legacy plugin removal against the pinned runtime. Inspect current service packaging and startup. Select the smallest supported integration; record concrete decisions here.
2. Add failing focused tests for automatic registration, instance binding, fresh/repeated setup, skill addition/removal, preservation of user files, collision/failure handling and release rollback where practical.
3. Implement the shared built-in setup and application-owned skill bundle. Reuse the gateway MCP command and control binding. Wire release packaging and development startup into the same path.
4. Remove Control-specific install/status endpoints, config, marketplace artifacts, UI/query hooks and obsolete tests. Retain general native plugin capabilities. Regenerate OpenAPI/frontend contracts.
5. Update README, service documentation and AGENTS workflow; remove cachebuster/reinstallation instructions. Validate and obtain an independent bounded review; fix findings, then commit coherent changes.

## Validation and exit conditions

- A disposable dedicated home discovers exactly one Control server and the bundled skills without manual installation. Verify actual pinned-runtime discovery, not only config strings.
- Repeated setup is safe; updates remove retired owned skills and preserve unrelated skills/config; interruption/failure is recoverable. Matching release assets work on rollback, with transition limitations explicitly tested/documented.
- Existing plugin installations do not produce duplicate tools. No desktop/shared home is modified.
- Preferences no longer offers Control Install/Reinstall; remaining preferences and general MCP/plugin features work. Use bundled Chromium for browser-observable validation; locate agent-browser skill if needed.
- Appropriate Rust tests, service Python tests, frontend tests/build, generated contracts, backend/frontend trims and formatting pass. Meaningful tests cover behavior rather than implementation strings.
- Independent review reports no major issues. Plan/index and contributor docs reflect the final design. Production deployment remains separate.

## Scope exclusions

No dynamic-tool transport rewrite, remote MCP hosting, new authorization system, general plugin manager, external-client distribution or skill package manager. No unrelated workspace cleanup. Existing untracked .kodex/ and tmp/ are user-owned and excluded.

## Final design and validation

- `runtime/kodex/skills` is embedded through a small explicit inventory in the gateway binary. No second artifact version or installer is maintained. Startup reconciles files in `CODEX_HOME/skills/kodex-builtin`; an owned-file receipt preserves unrelated skills/files and supports removals and rollback. Initial ownership is staged outside discovery and published by rename; individual updates use atomic file replacement and a union receipt for retry/recovery.
- The existing MCP command is registered only in managed app-server launch overrides. The legacy local plugin key is disabled only for that launch, leaving external accounts and saved config untouched. Native overrides merge tables: a manual `mcp_servers.kodex-control` entry in the dedicated config or startup arguments is rejected with an actionable error rather than overwritten or silently inherited. A standard TOML parser supports this narrow check.
- Service releases carry the embedded bundle in the gateway executable. Development uses the same setup. Frontend-only updates do not affect it. Rollback between built-in releases restores the embedded inventory; rollback to pre-built-in releases uses their old plugin setup and may leave the prefixed skill on disk. This transition limit is documented; no migration of old user storage is introduced.
- Removed the opt-in Preferences panel, install/status endpoints, config flag, marketplace assets, plugin manifests/launcher, cachebuster workflow and obsolete tests/CSS. General native MCP/plugin APIs remain. Frontend OpenAPI types were regenerated.
- Real pinned 0.160.0 proofs pass for a fresh built-in server and a natively installed legacy plugin followed by two managed starts: exactly one Control provider, built-in skill discovery, old plugin skill disabled, owning gateway calls and explicit thread-target enforcement, user config unchanged, and manual collision rejected. All proof state is disposable; production is untouched.
- Unit tests cover repeated reconciliation, addition/removal and rollback, preservation of user skills and added files, ownership/symlink rejection, interrupted staging/partial updates and manual server/config-argument collision before skill writes.
- Final validation: 695 backend library tests pass (3 existing ignores), main/process integration tests pass; 59 service tests pass; 1,330 frontend tests pass (1 skipped); both real-native Control proofs pass; frontend build/typecheck, backend/frontend trims, formatting and diff checks pass. Three bundled-Chromium preferences tests pass across desktop, narrow fine pointer and narrow touch, with screenshot inspection. The agent-browser skill was unavailable in local catalogs; existing Playwright browser evidence covers this UI removal.
- No shared thread lifecycle behavior changed; canonical gateway state/queue/approval policies remain unchanged. Built-in registration is runtime-owned, independent of any tab. Existing cross-client coverage remains in the passing suites.
- Independent review identified and drove fixes for first-install interruption and saved/argument MCP field inheritance. Three review passes completed; final review reports no further major findings. Final seven focused setup tests, both native proofs and backend trim pass after fixes. All exit conditions are satisfied, with the documented pre-built-in rollback limitation. No production deployment or push was performed.
