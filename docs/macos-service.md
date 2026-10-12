# Legacy combined macOS service

This page applies only to the already-installed combined Kodex service under `~/.local/share/kodex`. The repository controller and binaries are now split-only: they require an explicit `executor` or `federator` role, and `kodex-gateway` no longer serves the web app or runs browser Push provider delivery.

Do not install or update the combined service from this checkout. Its installed controller and current release remain untouched until an explicit fresh cutover. Continue to use that installed controller only for operations against its existing release:

```bash
~/.local/share/kodex/kodex-service status
~/.local/share/kodex/kodex-service logs
~/.local/share/kodex/kodex-service start
~/.local/share/kodex/kodex-service stop
~/.local/share/kodex/kodex-service restart
~/.local/share/kodex/kodex-service operation-status
```

Do not run `update` or `update-frontend` for the combined service with the federated checkout: new executor releases contain no frontend, new federator releases contain no Codex runtime, and the current web client targets the federator contract. Existing rollback targets remain owned by the installed legacy controller and should be used only under the compatibility policy recorded with that deployment.

For a new installation, independent lifecycle, noncolliding staging ports, Tailscale HTTPS routing, role-specific updates, rollback behavior and the platform evidence matrix, use [Federated Kodex services](federated-service.md). The fresh split roots do not overwrite the combined installation. Stop the combined service only as part of a separately authorized cutover after the new federator and executor have passed the documented host checks.

The combined service has no authentication layer and exposes host files, terminals and account operations. Keep its existing listener on localhost behind private Tailscale access; do not use Funnel or expose it publicly.
