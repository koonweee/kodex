# Composer Cleanup Plan

## Scope

Refine the Kodex web composer so active-turn controls stay in one place. The main composer remains the only text entry point. When a turn is running, sending text queues it as a steer candidate above the composer, and the normal send button becomes the stop button.

This is a frontend-only interaction cleanup unless implementation discovers a gateway contract issue. It must not change generated OpenAPI artifacts or introduce handwritten gateway DTOs.

## Status

Proposed.

## Principles

- Red first where practical: add or update component coverage before changing composer behavior.
- One composer: keep message entry in the main composer for both new turns and active-turn steering.
- Keep controls predictable: the primary composer action reflects the active turn state.
- Match chat composer conventions: Enter submits, Shift+Enter inserts a newline.
- Preserve gateway contracts: continue using the generated client wrappers for start, steer, and interrupt requests.
- Keep the change scoped to composer interaction and styling.

## Current Problem

The web client currently separates active-turn actions across multiple controls:

- A separate stop button appears next to the send button.
- A separate steer composer appears below the main composer during an active turn.
- The main composer is not the single place where users type the next thing they want Codex to consider.
- Composer keyboard behavior does not explicitly follow the expected Enter-to-send, Shift+Enter-for-newline interaction.

This creates extra visual weight at the bottom of the thread and makes steering feel like a second mode rather than a natural continuation of the conversation.

## Milestone 1: Composer State and Tests

Status: Proposed

Failing tests first:

- Active turns do not render a separate stop button.
- Active turns do not render a separate steer composer.
- The main composer stays enabled during an active turn.
- The send button becomes the stop button while a turn is running.
- The stop button renders a solid square icon.
- Submitting text during an active turn queues a steer row above the composer.
- Pressing Enter submits the composer.
- Pressing Shift+Enter inserts a newline without submitting.
- Clicking a queued row's steer action posts to the steer endpoint.
- A successfully steered row disappears after the request completes.
- A failed steer request leaves the row available for retry.

Implementation:

- Remove the dedicated steer text state.
- Add queued steer row state with stable row IDs and message text.
- Treat main composer submission as a turn start when no turn is active.
- Treat main composer submission as queued steer text when a turn is active.
- Add composer key handling for Enter submit and Shift+Enter newline.
- Clear queued steer rows when the selected thread changes or when there is no active turn.

Exit conditions:

- Composer tests cover idle send, active stop, active steer queueing, successful steer removal, and failed steer retry.
- Existing MVP composer tests still pass after updating expectations.

## Milestone 2: Unified Composer Controls

Status: Proposed

Failing tests first:

- Idle composer action has the accessible name `Send message` and starts a turn.
- Active composer action has the accessible name `Stop turn` and interrupts the active turn.
- No additional stop control is reachable while a turn is active.
- The idle send action uses a round background and a simple arrow icon.

Implementation:

- Replace the send-plus-stop control group with one primary composer action.
- In idle state, render a simpler send arrow icon in a round button and submit the composer form.
- In active-turn state, render a solid square stop icon and call the interrupt endpoint.
- Disable the idle send action when the composer is empty or no thread can be composed into.
- Keep the active stop action enabled whenever an active turn exists for the selected thread.

Exit conditions:

- The composer has one primary action button in both idle and active states.
- The idle send affordance is visually round and uses the simpler send arrow direction.
- The active stop affordance uses a solid square icon.
- Interrupt behavior remains wired to `POST /v1/threads/:threadId/turns/:turnId/interrupt`.

## Milestone 3: Queued Steer Card

Status: Proposed

Failing tests first:

- Queued steer rows render in a card connected to the top of the composer.
- Each queued row shows the queued message and a right-aligned `Steer` button.
- Clicking `Steer` sends that row's text to the active turn.
- Successful steer removes only the submitted row.
- Failed steer keeps the row visible and retryable.

Implementation:

- Remove the standalone `.kodex-steer` form.
- Add a queued-steer card above the main composer when queued rows exist.
- Render one compact row per queued message.
- Use the existing error reporting path for failed steer submissions.
- Keep row layout stable on desktop and mobile.

Exit conditions:

- The separate steer composer is gone.
- Queued steer rows visually extend from the composer instead of rendering as an independent form.
- Steer submissions continue to use `POST /v1/threads/:threadId/turns/:turnId/steer`.

## Milestone 4: Styling and Regression Pass

Status: Proposed

Failing tests first:

- Existing shell and composer layout tests still pass on the updated structure.
- Playwright coverage is added only if the interaction proves too broad for component tests alone.

Implementation:

- Remove obsolete steer form styles.
- Add queued-steer card styles that connect cleanly to the composer.
- Keep the composer anchored and stable inside the existing thread layout.
- Verify mobile layout does not overlap text, buttons, or queued rows.

Exit conditions:

- `cd apps/web && npm test` passes.
- `cd apps/web && npm run build` passes if the implementation touches TypeScript or production bundle behavior.
- README and AGENTS updates are unnecessary unless commands, setup, or workflow conventions change.
