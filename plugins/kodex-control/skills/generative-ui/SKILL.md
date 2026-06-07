---
name: generative-ui
description: Open or update a temporary thread-bound interactive app-surface pane when visual structure, direct manipulation, forms, comparisons, previews, branching choices, or repeated actions are clearer than chat alone; use the Kodex Control app-surface MCP tools rather than duplicating their schema.
---

# Generative UI

Use this skill when a Kodex thread would be clearer with a temporary interactive HTML pane than with chat alone: mockup comparisons, structured questionnaires, visual pickers, small calculators, review dashboards, architecture maps, option boards, or task-specific controls.

Generated app surfaces should justify their presence. Use them when layout, visual grouping, direct manipulation, branching choices, comparison, preview, progressive disclosure, or repeated actions make the experience clearer or faster. Avoid opening an app surface for content that works just as well as a normal chat response.

## Workflow

- Use `open_app_surface` to create the pane.
- Use `update_app_surface` when the user asks for a revision, follows an app-surface action, or needs the pane to reflect new data.
- `open_app_surface` focuses the new pane by default. Pass `presentation: "open"` only when the browser should make the pane available without switching focus. For `update_app_surface`, pass `presentation: "focus"` when the revision should become active; omit `presentation` only for background/non-disruptive updates.
- Use `show_app_surface` with `action: "open"` or `action: "focus"` to open or focus the latest existing pane without replacing its server-side content. Do not promise unsaved local UI edits remain intact: if the previous iframe was closed, hidden, unmounted, or reloaded, in-iframe state may reset unless the app explicitly saved or submitted that state.
- Use `get_app_surface` only when you need to inspect the current pane metadata.
- Use `archive_app_surface` when the user asks to dismiss or remove the app surface.
- Pair every open or update with a short assistant message that says what the pane is for.
- Pass nested metadata as JSON objects, not strings. For example, use `grants: { "canSendMessage": true }` and `csp: { "connectDomains": [], "resourceDomains": [] }`; do not pass `grants: "{\"canSendMessage\":true}"`, `permissions: "{}"`, or a CSP header string.
- Treat the MCP tool schemas and validation errors as the source of truth for required fields and limits. Do not inspect the Kodex repository or gateway source code to learn how app surfaces work; production agents will not have that source. Do not restate or invent a parallel schema in the skill.

## Thread Targeting

- In normal thread use, omit `threadId`; the Kodex app-server supplies the invoking thread through MCP `_meta.threadId`. Pass `threadId` only when the user explicitly wants to target another thread.
- Do not list recent threads or ask the user for the current thread ID before rendering an app surface. If an app-surface tool reports that `_meta.threadId` is unavailable, then retry with an explicit `threadId` only if you can identify it with high confidence.

## UI Requirements

- Keep the UI self-contained HTML/CSS/JS unless the tool grants and CSP explicitly allow otherwise. Generated app surfaces are served in a sandboxed iframe and external network access is denied by default.
- MCP tool/resource bridge access is gateway-mediated by stored grants. Generated-provider MCP tool calls require user approval before execution, so design controls to handle an approval-required response and let the user retry after approval when needed.
- Strongly prefer a theme-native UI unless the user explicitly asks for a distinct visual style. Use injected Kodex semantic CSS variables for the document body, surfaces, cards, text, borders, buttons, chart marks, status colors, focus rings, shadows, and radii.
- Avoid inventing custom palettes, gradients, stock dashboard chrome, or hard-coded color schemes for ordinary generated app surfaces.
- Use raw color literals only as fallback values inside `var(--kodex-..., fallback)` declarations, for small data-visualization distinctions that still harmonize with Kodex tokens, or when the user explicitly asks for branded/custom styling.
- Make the UI responsive for both desktop split pane and mobile full-height bottom sheet.
- Prefer interactive controls, visual structure, branching choices, comparisons, previews, progressive disclosure, or repeated actions over static text.
- Do not request secrets, credentials, or sensitive personal data.

## Interaction Patterns

- Generated app surfaces may include both local UI interactions and conversational actions. Buttons are not inherently prompts.
- If any control submits a conversational action with `window.kodex.submitMessage` or raw `ui/message`, declare `grants: { "canSendMessage": true }` in the app-surface tool call.
- Visualization or dashboard: drilldowns, modals, tabs, filters, chart toggles, unit switches, and progressive disclosure should usually be local.
- Prototype or configurator: controls can update the local preview, while explicit actions submit the chosen direction or request the next model response.
- Questionnaire, approval, or workflow: answer submission, plan approval, investigation requests, visualization regeneration, automation updates, and follow-up artifacts should submit to the thread.
- Decision board: each option can expose conversational actions such as `Choose`, `Compare`, or `Risks`.
- Architecture map: each subsystem can expose conversational actions such as `Deep dive`, `Request flow`, `Data ownership`, or `Code map`.
- Review dashboard: each finding can expose conversational actions such as `Fix`, `Explain`, or `Defer`.
- Plan view: each milestone can expose conversational actions such as `Implement`, `Review`, or `Split smaller`.

For conversational actions, prefer the host-injected helper. It sends a concise human-readable `ui/message` request that stands alone as the next user instruction and returns a Promise that resolves or rejects from the JSON-RPC response:

```html
<button onclick="window.kodex.submitMessage('hi', { source: 'app-surface', action: 'hi' })">
  Hi
</button>
<button onclick="window.kodex.submitMessage('bye', { source: 'app-surface', action: 'bye' })">
  Bye
</button>
```

If you use raw `postMessage`, send MCP Apps JSON-RPC to the host bridge. The `content` must include a human-readable text block, and `_meta` should stay compact:

```js
window.parent.postMessage({
  jsonrpc: "2.0",
  id: crypto.randomUUID(),
  method: "ui/message",
  params: {
    role: "user",
    content: { type: "text", text: "human-readable message" },
    _meta: { source: "app-surface", action: "..." }
  }
}, "*");
```

Use `_meta` only for compact structured details such as `source`, `section`, `action`, `selectedId`, or `selectedLabel`. Do not auto-submit on load; send `ui/message` only from explicit UI controls.

Before opening or updating an app surface, check:

- Is this richer or clearer than chat alone?
- Can each interaction be local, or does it need Codex, tools, external data, persistence, workflow continuation, or an explicit user decision?
- If it has multiple sections or choices, does each likely user intent have the right local control or conversational action?
- Does every conversational action submit a human-readable `message`, not only metadata?
- Is metadata compact and structured?
- Does the UI look like a native Kodex pane rather than a standalone mini-site or generic dashboard?
- Do the CSS rules use `var(--kodex-...)` tokens for all core chrome and only use raw colors as fallbacks or intentional small chart distinctions?
- Is the UI responsive in split-pane and mobile sheet layouts?

## Theme Tokens

Generated app-surface documents receive Kodex theme tokens inside the iframe. Treat these as the default design system for app-like controls, dashboards, forms, pickers, and mockup selectors. The generated CSS should read like Kodex-native UI chrome first, with task-specific layout second:

```css
body {
  margin: 0;
  background: var(--kodex-bg-panel, #151515);
  color: var(--kodex-text-primary, #f3f3f3);
  font-family: var(--kodex-font-family, ui-sans-serif, system-ui, sans-serif);
}

.card {
  border: 1px solid var(--kodex-border-subtle, #2b2b2b);
  border-radius: var(--kodex-radius-md, 8px);
  background: var(--kodex-bg-raised, #0d1211);
}

button {
  background: var(--kodex-accent, #2fa987);
  color: var(--kodex-text-on-accent, #f6fffc);
}

.chart-income {
  color: var(--kodex-success, #38a96a);
}

.chart-spend {
  color: var(--kodex-danger, #ff8e7a);
}
```

Useful variables include `--kodex-bg-app`, `--kodex-bg-panel`, `--kodex-bg-raised`, `--kodex-bg-raised-muted`, `--kodex-text-primary`, `--kodex-text-secondary`, `--kodex-text-muted`, `--kodex-border-subtle`, `--kodex-border-strong`, `--kodex-accent`, `--kodex-danger`, `--kodex-success`, `--kodex-warning`, `--kodex-info`, `--kodex-radius-sm`, `--kodex-radius-md`, `--kodex-radius-lg`, and `--kodex-font-family`.

For generated dashboards and visualizations, do not choose a fresh product palette by default. Build the UI with Kodex panel/card/text/border tokens, use `--kodex-success`, `--kodex-danger`, `--kodex-warning`, `--kodex-info`, and `--kodex-accent` for semantic chart series, and keep any extra chart colors muted and token-adjacent.

## When To Use

Use generated app surfaces when direct interaction materially reduces chat friction. Good fits include:

- Choosing between visual app mockups.
- Filling a multi-question planning form.
- Comparing options with toggles or sliders.
- Previewing a generated micro-tool or dashboard.

Avoid app surfaces for simple prose, ordinary code review notes, terminal output summaries, trivial yes/no questions, or anything that is better as a normal chat answer.
