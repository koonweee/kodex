# Automations Frontend Plan

## Status

Complete. Implemented the sidebar Automations entry, `/automations` main pane, `mantine-react-table` automation table, create/edit details modal with Markdown prompt editing, gateway snapshot plus SSE reconciliation, mobile responsiveness safeguards, generated mockup references, and focused frontend verification.

## Design References

Generated low-fidelity skeleton mockups:

- Sidebar navigation reference: [sidebar-automations-skeleton.png](assets/automations-frontend/sidebar-automations-skeleton.png)
- Automations pane reference: [automations-pane-skeleton.png](assets/automations-frontend/automations-pane-skeleton.png)
- Automation details modal reference: [automation-details-modal-skeleton.png](assets/automations-frontend/automation-details-modal-skeleton.png)

Use these as layout references, not exact visual specs. The implementation should still follow existing Kodex tokens, spacing, sidebar row primitives, and shell behavior.

## Existing Implementation Check

- `plans/automations.md` is complete and intentionally scoped to gateway API, OpenAPI, generated frontend types, scheduler behavior, and verification. It explicitly excludes a frontend management UI.
- Backend routes exist in `apps/gateway/src/routes/automations.rs`:
  - `GET /v1/automations`
  - `POST /v1/automations`
  - `GET /v1/automations/{automationId}`
  - `PATCH /v1/automations/{automationId}`
  - `POST /v1/automations/{automationId}/pause`
  - `POST /v1/automations/{automationId}/resume`
  - `DELETE /v1/automations/{automationId}`
- Scheduler logic exists in `apps/gateway/src/automations.rs` and queues automation prompts through the existing gateway queue path with `sourceType = "automation"`.
- Generated frontend types already include `AutomationDto`, create/update requests, schedule schemas, and queue source fields in `apps/web/src/api/generated/schema.ts`.
- `apps/web/src/api/client.ts` already exposes typed wrappers for list/create/update/pause/resume/delete.
- `apps/web/src/events/stream.ts` already subscribes to `automation.item_upsert` and `automation.item_deleted`, but `App.tsx` does not yet apply those events to UI state.
- `mantine-react-table` is not currently installed. A markdown prompt editor also does not currently exist.

## Goal

Add a first-class Automations area in the web client:

- Add an `Automations` button near the top of the sidebar, matching the screenshot's single-row navigation style.
- Clicking it selects an Automations config pane in the main area.
- The main pane title is `Automations`.
- The pane contains a `mantine-react-table` table of automations.
- The pane has an add button for creating a new automation.
- Each table row shows the automation name plus key metadata, and row click opens a modal editor.
- The modal supports full automation configuration, including a markdown prompt editor.
- State remains gateway-owned and converges across tabs through HTTP snapshot plus SSE events.

## Non-Goals

- No backend scheduler rewrite.
- No cron expressions, timezone-aware recurrence rules, prompt variables, dynamic thread targeting, or project-wide fanout.
- No run-history UI beyond the v1 metadata already exposed on `AutomationDto`.
- No browser-local durable automation definitions.
- No automatic cancellation of already queued automation prompts after pause or delete.

## Product Shape

Sidebar:

- Add a top-level `Automations` navigation row above `Pinned`.
- Use a `Clock` or `Repeat` lucide icon.
- The row gets the same selected state styling as other sidebar selectable rows.
- On mobile, tapping it switches to the main pane and closes the sidebar.
- Keep the button target at least 44px tall on mobile while preserving the compact desktop row height.

Main pane:

- Header: `Automations` title, mobile sidebar toggle, and an add action icon/button.
- Table columns:
  - Name
  - Target thread
  - Status
  - Next run
  - Repeat interval
  - Last run
  - Failures or last error
- Empty state: no automations yet, with the same add action available.
- Row click opens the edit modal.
- Optional row actions can expose pause/resume/delete, but the modal should include those controls even if the table keeps actions minimal.
- On narrow viewports, hide low-priority metadata columns or move them into row detail content instead of forcing tiny text.
- If horizontal table scrolling remains necessary on mobile, keep the first column readable and avoid nested scroll traps inside the app shell.

Editor modal:

- Reuse one modal for create and edit.
- Fields:
  - Name
  - Target thread
  - Start date/time
  - Repeat interval value
  - Repeat interval unit: seconds, minutes, hours
  - Prompt markdown editor
- For target thread selection, build grouped options from loaded project threads, chat threads, and pinned threads. Deduplicate by thread id. Prefer display titles over raw ids, but retain the raw id for submission.
- For create, preselect the most recently selected thread when available; otherwise select the first loaded thread if one exists.
- Validate required fields client-side before POST/PATCH:
  - name is non-empty
  - prompt is non-empty
  - target thread is selected
  - repeat interval is positive and at least 30 seconds after unit conversion
  - start date/time is valid
- Submit backend-shaped payloads from generated OpenAPI types, not handwritten duplicate DTOs.
- On mobile, render the editor as a near-fullscreen modal or drawer with a sticky footer so Save/Cancel remain reachable after editing the prompt.
- Keep top form fields single-column on mobile; do not squeeze `Start` and `Repeat every` side by side below tablet width.
- Use stable modal sizing: scrolling belongs inside the modal body, not the page behind it.

Markdown editor:

- Prefer a lightweight local `PromptMarkdownEditor` built from Mantine controls plus the existing `react-markdown`, `remark-gfm`, and `remark-breaks` dependencies.
- Use Write/Preview tabs and a fixed-height editor surface so preview toggles do not resize the modal unpredictably.
- Keep the source as plain Markdown text. Do not introduce a rich-text model that needs Markdown serialization.
- If a richer toolbar becomes necessary, add a dedicated markdown editor dependency in a separate follow-up.

## Mobile And Responsive Requirements

- Treat `900px` as the existing shell breakpoint, but verify the Automations pane at phone widths around 390px and tablet widths around 768px.
- Use `100dvh`-compatible sizing for the pane/modal so iOS browser chrome changes do not hide the footer actions.
- Keep tap targets for primary actions, sidebar navigation, row actions, and modal footer buttons at least 44px tall on mobile.
- Avoid Safari auto-zoom by ensuring every editable control rendered on mobile has an effective font size of at least `16px`:
  - text inputs
  - selects/comboboxes
  - date/time inputs
  - number inputs
  - markdown textarea
- Do not reduce input font size through parent scaling, CSS transforms, or Mantine size overrides on mobile.
- Use `inputMode="numeric"` for repeat interval input and keep the visible control height large enough for thumb editing.
- Prefer column reduction and row detail summaries over shrinking table text below readable sizes.
- Ensure modal labels, validation errors, and footer actions do not overlap when the on-screen keyboard is open.
- Verify with browser automation screenshots on desktop and mobile after implementation.

## State And Routing

Route ownership:

- Extend shell navigation to support `/automations`.
- Add a selected main pane state, for example `selectedMainPane: "thread" | "automations"`.
- Selecting a thread switches back to the thread pane and pushes `/threads/:threadId`.
- Selecting Automations pushes `/automations`.
- Root `/` should keep the current draft chat behavior.

Shell rendering:

- Keep `App.tsx` as the shell coordinator only.
- Move Automations UI into `apps/web/src/automations`.
- Update `KodexShellView` so the main stack renders either:
  - `ThreadPanel` plus `ComposerPanel`, or
  - `AutomationsPane`
- Do not render the composer under the Automations pane.

Automation state:

- Add `automations` state in `App.tsx` or a small hook under `apps/web/src/automations/useAutomationsState.ts`.
- Load an authoritative snapshot with `listAutomations()` when the Automations pane is first opened. Eager initial load is also acceptable if tests show it does not add startup jank.
- Apply `automation.item_upsert` and `automation.item_deleted` from the existing global event stream.
- Use a small reducer/helper for upsert/delete so tests can cover event behavior without rendering the whole app.
- Avoid overwriting live SSE changes with a stale HTTP snapshot. Track an automation event revision while a snapshot request is in flight; if events arrive before the snapshot resolves, apply the event changes and immediately refetch or discard the stale replacement.

Two-tab correctness:

- Creating, updating, pausing, resuming, or deleting in one tab must update the other tab via SSE without reload.
- Reload must reconcile from `GET /v1/automations`.
- The browser may own modal draft values, sorting, filters, hover, and selected row, but not the automation definitions.

## Dependencies

- Add `mantine-react-table` to `apps/web/package.json` and commit `package-lock.json`.
- Add peer dependencies only if `npm install mantine-react-table` requires them. Do not manually duplicate table types.
- Do not add a markdown editor package for the first pass unless the local editor proves inadequate.

## File Plan

- `apps/web/src/automations/AutomationsPane.tsx`
- `apps/web/src/automations/AutomationEditorModal.tsx`
- `apps/web/src/automations/PromptMarkdownEditor.tsx`
- `apps/web/src/automations/events.ts`
- `apps/web/src/automations/schedule.ts`
- `apps/web/src/automations/threadOptions.ts`
- `apps/web/src/automations/state.ts`
- `apps/web/src/automations/*.test.ts`
- `apps/web/src/App.tsx`
- `apps/web/src/shell/KodexShellView.tsx`
- `apps/web/src/shell/navigation.ts`
- `apps/web/src/threads/WorkspaceSidebar.tsx`
- `apps/web/src/styles/automations.css`
- `apps/web/src/App.css`
- `apps/web/package.json`
- `apps/web/package-lock.json`

## Milestone 1: Navigation And Pane Shell

Failing tests first:

- App integration test clicks the sidebar `Automations` button and sees the main heading `Automations`.
- The composer is not rendered while the Automations pane is selected.
- Browser route becomes `/automations`.
- Selecting a thread after visiting Automations returns to the thread pane.

Implementation:

- Extend `KodexRoute` parsing and path helpers for `/automations`.
- Add selected main pane state in `App.tsx`.
- Add the sidebar button and selected styling.
- Update `KodexShellView` to render an automation pane placeholder.

Exit conditions:

- Focused navigation tests pass.
- Existing deep-link and draft composer tests still pass.
- Mobile route behavior works from `/automations?panel=threads` and from direct `/automations` navigation.

## Milestone 2: Snapshot, SSE State, And Table

Failing tests first:

- `GET /v1/automations` rows render in the table.
- `automation.item_upsert` inserts or replaces a row.
- `automation.item_deleted` removes a row.
- A stale snapshot response cannot re-add a row deleted by a live event during loading.

Implementation:

- Add automation state helpers and event parsing.
- Load `listAutomations()` on first pane open.
- Wire the existing global event stream to automation state.
- Add `mantine-react-table` and implement the first table with stable columns.
- Format timestamps in the user's local time and intervals as compact text.
- Add responsive table configuration so mobile keeps readable name/status/next-run information without tiny columns.

Exit conditions:

- Automation table tests pass.
- Existing event stream tests still pass.
- Mobile table layout has no overlapping text at phone width.

## Milestone 3: Create And Edit Modal

Failing tests first:

- Add button opens the modal with empty/default create fields.
- Submit create sends a typed `AutomationCreateRequest`.
- Row click opens the same modal populated from the row.
- Save edit sends only changed fields where practical, or a safe partial update using `AutomationUpdateRequest`.
- Backend errors surface through the existing app error path or modal inline error.

Implementation:

- Build `AutomationEditorModal`.
- Build `PromptMarkdownEditor` with Write/Preview tabs.
- Build schedule mapping helpers for DTO to form state and form state to create/update payload.
- Build target thread options from already loaded project/chat/pinned threads.
- Optimistically close the modal only after successful response, then apply the returned automation.
- Add mobile modal layout and 16px minimum input font-size styling for every editable field.

Exit conditions:

- Create/edit tests pass.
- TypeScript build passes with generated OpenAPI types.
- Mobile modal fields do not trigger Safari zoom and footer actions remain reachable with the keyboard open.

## Milestone 4: Pause, Resume, Delete, And Polish

Failing tests first:

- Paused rows show paused status.
- Pause/resume controls call the correct API wrapper and update the row from the response.
- Delete confirms intent, calls the delete wrapper, and removes the row.
- Last error and consecutive failures are visible without making the table visually noisy.

Implementation:

- Add modal actions for pause/resume/delete.
- Add row-level status badges and compact error display.
- Add responsive styling in `styles/automations.css`.
- Keep table and modal dimensions stable on desktop and mobile.
- Check generated visual references against implementation for broad layout parity: sidebar row placement, table hierarchy, and details modal structure.

Exit conditions:

- Focused CRUD tests pass.
- `cd apps/web && npm test` passes.
- `cd apps/web && npm run build` passes.

## Review And Verification

- Run the relevant frontend tests after each milestone.
- Run full `npm test` and `npm run build` before completion.
- Use browser QA for desktop and mobile widths after implementation.
- Review two-tab behavior before marking complete:
  - tab A creates, updates, pauses, resumes, and deletes
  - tab B observes SSE changes
  - reload in tab B reconciles through `GET /v1/automations`
- Run an independent review pass before moving the plan to Complete.
