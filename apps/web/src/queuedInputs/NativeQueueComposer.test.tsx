import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { App, activeThread, baseRoutes, mockGateway, requestJson, thread, secondThread } from "../test/mvpAppHarness";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("sends active-chat input through the native atomic command and queues only explicit Queue intent", async () => {
  const gateway = mockGateway(baseRoutes({ "GET /v1/threads": { threads: [activeThread] } }));
  render(<App />);
  await screen.findByText("Hello from Codex");
  const composer = screen.getByRole("textbox", { name: "Message composer" });
  await userEvent.type(composer, "Live correction");
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(gateway.callsFor("POST", "/v1/threads/thread-1/input")).toHaveLength(1));
  expect(gateway.callsFor("POST", "/v1/threads/thread-1/queued-inputs")).toHaveLength(0);
  await expect(requestJson(gateway.callsFor("POST", "/v1/threads/thread-1/input")[0])).resolves.toEqual({ input: [{ type: "text", text: "Live correction" }], clientUserMessageId: expect.any(String) });
  await userEvent.type(composer, "Next-turn work");
  await userEvent.click(screen.getByRole("button", { name: "Queue message" }));
  const queue = await screen.findByRole("region", { name: "Queued messages" });
  expect(queue).toHaveTextContent("Next-turn work");
  expect(composer).toHaveValue("");
  expect(gateway.callsFor("POST", "/v1/threads/thread-1/input")).toHaveLength(1);
  await expect(requestJson(gateway.callsFor("POST", "/v1/threads/thread-1/queued-inputs")[0])).resolves.toEqual({ input: [{ type: "text", text: "Next-turn work" }], clientUserMessageId: expect.any(String) });
  await userEvent.click(within(queue).getByRole("button", { name: "Steer" }));
  expect(await screen.findByText("Awaiting native receipt")).toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Queued messages" })).not.toBeInTheDocument();
  expect(gateway.callsFor("POST", "/v1/threads/thread-1/queued-inputs/queue-1/steer")).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
});


it.each([
  ["Edit", "Edit queued message"],
  ["Restore to composer", "Restore saved input"],
  ["Saved input", "Saved native input"],
])("closes %s state when browser navigation activates another thread", async (action, title) => {
  const gateway = mockGateway(baseRoutes({
    "GET /v1/threads": { threads: [thread, secondThread] },
    "GET /v1/threads/thread-1/queued-inputs": {
      queuedInputs: [{ id: "old-row", threadId: "thread-1", clientUserMessageId: "original", input: [{ type: "text", text: "Old queued text" }], attachments: [], canSteer: false }],
      transfers: [{ id: "old-transfer", threadId: "thread-1", nativeQueueId: "old-native-row", clientUserMessageId: "original", expectedTurnId: "old-turn", input: [{ type: "text", text: "Old saved text" }], phase: "uncertain", createdAt: "2026-10-05T00:00:00Z", updatedAt: "2026-10-05T00:00:00Z" }], nextCursor: null,
    },
  }));
  render(<App />);
  await screen.findByRole("heading", { name: /^implement frontend$/i });
  await userEvent.click(await screen.findByRole("button", { name: action }));
  await waitFor(() => expect(screen.getByRole("dialog", { name: title })).toBeVisible());
  // Browser navigation can change the pane while a portal dialog is open.
  await act(async () => {
    window.history.pushState(null, "", "/threads/thread-2");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await screen.findByRole("heading", { name: /^second thread$/i });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: title })).not.toBeInTheDocument());
  const activePane = document.querySelector<HTMLElement>('.kodex-thread-pane[data-workspace-pane-active="true"]')!;
  expect(within(activePane).getByRole("textbox", { name: "Message composer" })).toHaveValue("");
  expect(gateway.callsFor("POST", "/v1/threads/thread-2/input")).toHaveLength(0);
  expect(gateway.callsFor("POST", "/v1/threads/thread-2/queued-inputs")).toHaveLength(0);
});
