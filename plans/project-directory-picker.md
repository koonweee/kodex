# Project directory picker

## Status

Complete. Implemented, independently reviewed and committed; deployment is separate.

## Scope

Project creation offers only **Root directory**. It starts browsing the gateway host's home directory, lists immediate child directories, permits moving up only within home, and selects the current directory with **Use this directory**. Selection replaces the browser with one path row and a remove button. Removing it reopens the browser at that directory. There is no manual path field, project-name field or helper text; the native project name is the selected directory's basename.

The directory endpoint is a read-only filesystem adapter with no durable state. Canonical containment enforces the home boundary, including symlinks. This custom adapter supplies the web picker with host filesystem data; native project ownership and creation remain unchanged.

New project chats and project terminals use the sole project root. The separate chat working-directory chooser and stale browser overrides are removed. Native projects with zero or multiple roots require their root configuration to be corrected before execution. Existing chats keep their native execution directory; membership changes do not relocate them. Non-project chats retain their existing scratch-directory behavior.

## Validation

- Directory API: default home, children only, sorting, parent boundary, missing/file/relative paths and symlink escape.
- Picker: navigation, selection/removal, loading/error retry and native create idempotency.
- Project execution: root routing for settings, skills, chat creation and terminals; stale cwd overrides cannot select another directory.
- Browser checks at desktop, narrow fine pointer and narrow touch; native project-list convergence across two tabs.
- Generated OpenAPI types, production build, relevant tests, trims and independent review.

Deployment requires the installed macOS service update workflow after validation.

Validation passed: 856 frontend tests; full backend suite with 603 library tests plus the subsequently added stale-root regression (604 current library tests covered), four binary/integration checks; seven affected browser workflows and a narrow-touch visual rerun. Production build, generated API types, backend/frontend trim and independent reviews pass. Tests confirm browsing/error recovery and selected-root layout at desktop, narrow fine-pointer and narrow touch sizes. Native create identity and second-tab project convergence remain covered. Existing native proof suites were not rerun for this filesystem/UI change.
