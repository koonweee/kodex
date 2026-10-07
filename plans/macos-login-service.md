# macOS login service

Status: Complete. Requested 2026-10-05 after native redesign completion.

Implement a small launchd management command for per-user login hosting, explicit start/stop/restart/status/logs and independent autostart, staged compiled gateway/frontend/native executable/Control packaging, version/readiness checks, port-conflict refusal, and explicit data-compatible rollback. Keep Tailscale Serve independent, preserve existing proxy mappings, and leave old state intact. The user requested installing and starting the completed service; login autostart is the chosen startup mode.

Exit: meaningful lifecycle/failure tests, independent review, documented setup/update/data limits, real installed service start/stop/restart and readiness evidence. No automatic storage rollback, migrations, root daemon, package manager or public exposure. Record any live deployment limitations explicitly.


## Verification and installed outcome

Completed 2026-10-05. All 18 lifecycle tests pass, including port conflict refusal, unrelated installation ownership, staging/build failure safety, same-origin frontend packaging, native version gating, signed app-bundle resources, readiness/instance identity and explicit rollback acknowledgment. Independent review found and resolved the frontend routing and job ownership issues; the macOS bundle fix also passed independent review.

The real release build and frontend build pass. Installed into the user's `~/.local/share/kodex` with fresh `~/.kodex/native-v1` state. Real launchd stop released port 8787; start, restart and a staged update passed owned-process/native/frontend health checks. Autostart off/on preserved the running PID. A real competing listener caused both manual startup and the login entry point to refuse without killing it. A deliberate gateway crash recovered automatically to a different PID and passed native readiness. Login autostart is enabled and its plist validates; no actual logout/reboot was performed.

Private Tailscale HTTPS on port 443 passes certificate-verified HTTP readiness and renders the actual app in the browser. The pre-existing proxy on 8443 was preserved. The existing Tailscale daemon already has system startup configured. The final gateway remains running and ready; its fresh account is signed out and requires user authorization. No desktop credentials or old stores were imported. Target-device PWA checks remain outside this task, as previously waived.

Sanitized local evidence: `/private/tmp/kodex-service-live-evidence.json`; build/install/update logs are `/private/tmp/kodex-service-release-build.log`, `/private/tmp/kodex-service-install.log`, and `/private/tmp/kodex-service-update.log`. Rollback is covered by logic tests and requires operator storage-compatibility acknowledgment; no persistent data rollback was performed.

## Independent operation follow-up (2026-10-07)

A deployment issued by an agent hosted on Kodex stopped its own gateway and updater before release activation. Full updates, restarts, rollbacks and the initial installation now use an independent one-shot launchd worker, with durable status/logs and optional observation. Frontend-only updates remain synchronous. Worker interruption never triggers automatic replay or storage rollback. The gateway's ordinary launchd crash-recovery policy is unchanged.

All 57 service tests pass, including cross-process handoff, startup-lock waiting, persisted success/failure, observer failure reporting, interrupted-worker recovery, status/completion races and preserving the management controller across gateway rollback. Independent review identified and resolved the status race and rollback regression. A disposable real launchd job completed after terminating its submitting process, had launchd as its parent, ran its action exactly once and refused replay after a forced kickstart; its registration was removed afterward. Evidence: `/private/tmp/kodex-operation-live-3ne4c5ey`. No production restart was needed for this validation.

The reviewed management files from commit `608893f` were installed separately into `~/.local/share/kodex/controllers/608893fa294a`, with `controller` and `kodex-service` selecting that snapshot. Installed `status` and `operation-status` commands pass. Gateway PID remained **78016**, native/frontend health passed, and `current`, `previous`, configuration and both launchd definitions were unchanged. The backend and frontend were not rebuilt or redeployed for this tooling upgrade. Installation evidence: `/tmp/kodex-controller-install-608893fa294a.json`.
