# macOS login service

Status: Active. Requested 2026-10-05 after native redesign completion.

Implement a small launchd management command for per-user login hosting, explicit start/stop/restart/status/logs and independent autostart, staged compiled gateway/frontend/native executable/Control packaging, version/readiness checks, port-conflict refusal, and explicit data-compatible rollback. Keep Tailscale Serve independent, preserve existing proxy mappings, and leave old state intact. The user requested installing and starting the completed service; login autostart is the chosen startup mode.

Exit: meaningful lifecycle/failure tests, independent review, documented setup/update/data limits, real installed service start/stop/restart and readiness evidence. No automatic storage rollback, migrations, root daemon, package manager or public exposure. Record any live deployment limitations explicitly.
