import { MantineProvider } from "@mantine/core";
import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { createKodexQueryClient } from "../api/queryClient";
import { queryKeys } from "../api/queryKeys";
import type { QueueTransfer } from "../api/client";
import { mockGateway, requestJson } from "../test/gatewayMock";
import { NativeQueuePanel } from "./NativeQueuePanel";
import { applyQueueEvent } from "./cache";

afterEach(() => vi.restoreAllMocks());
const row = (id: string, canSteer = false) => ({ id, threadId: "chat", clientUserMessageId: "reusable", input: [{ type: "text", text: id }], attachments: [], canSteer });
const saved = (phase: QueueTransfer["phase"]): QueueTransfer => ({ id: "transfer", threadId: "chat", nativeQueueId: "b", clientUserMessageId: "reusable", expectedTurnId: "turn", input: [{ type: "text", text: "Saved correction" }], phase, error: phase === "uncertain" ? "Acknowledgement lost" : null, createdAt: "2026-10-05T00:00:00Z", updatedAt: "2026-10-05T00:00:00Z" });
function mount(onRestoreText = vi.fn()) {
  const client = createKodexQueryClient();
  render(<QueryClientProvider client={client}><MantineProvider env="test"><NativeQueuePanel threadId="chat" canRestoreText onRestoreText={onRestoreText} /></MantineProvider></QueryClientProvider>);
  return client;
}

it("only offers reordering when there are multiple queued messages", async () => {
  let rows = [row("Only message")];
  mockGateway({ "GET /v1/threads/chat/queued-inputs": () => ({ queuedInputs: rows, transfers: [], nextCursor: null }) });
  const client = mount();
  await screen.findByRole("group", { name: "Queued message" });
  expect(screen.queryByRole("button", { name: "Reorder queued message" })).not.toBeInTheDocument();
  rows = [...rows, row("Second message")];
  applyQueueEvent(client, { id: "1", seq: 1, kind: "turn_queue.changed", threadId: "chat", payload: { threadId: "chat" }, receivedAt: "2026-10-07T00:00:00Z" });
  await waitFor(() => expect(screen.getAllByRole("button", { name: "Reorder queued message" })).toHaveLength(2));
  rows = rows.slice(0, 1);
  applyQueueEvent(client, { id: "2", seq: 2, kind: "turn_queue.changed", threadId: "chat", payload: { threadId: "chat" }, receivedAt: "2026-10-07T00:00:00Z" });
  await waitFor(() => expect(screen.queryByRole("button", { name: "Reorder queued message" })).not.toBeInTheDocument());
});

it("uses native order and eligibility, preserves unknown native input when editing, and submits one complete reorder", async () => {
  let rows = [{ ...row("b", true), input: [{ type: "text", text: "b", nativeKey: "keep" }, { type: "futureInput", opaque: [1, 2] }] }, row("a")];
  const writes: unknown[] = [];
  mockGateway({
    "GET /v1/threads/chat/queued-inputs": () => ({ queuedInputs: rows, transfers: [], nextCursor: null }),
    "PUT /v1/threads/chat/queued-inputs/b": async (request: Request) => { const body = await requestJson(request); writes.push(body); rows = rows.map((item) => item.id === "b" ? { ...item, input: body.input } : item); return { queuedInput: rows[0] }; },
    "POST /v1/threads/chat/queued-inputs/reorder": async (request: Request) => { const body = await requestJson(request); writes.push(body); rows.reverse(); return {}; },
  });
  mount();
  const groups = await screen.findAllByRole("group", { name: "Queued message" });
  expect(groups.map((group) => group.textContent?.slice(0, 1))).toEqual(["b", "a"]);
  expect(within(groups[0]).getByRole("button", { name: "Steer" })).toBeEnabled();
  expect(within(groups[1]).queryByRole("button", { name: "Steer" })).not.toBeInTheDocument();
  await userEvent.click(within(groups[0]).getByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByLabelText("Queued message text"), { target: { value: "Edited" } });
  await userEvent.click(screen.getByRole("button", { name: "Save queued message" }));
  await waitFor(() => expect(writes[0]).toEqual({ input: [{ type: "text", text: "Edited", nativeKey: "keep", text_elements: [] }, { type: "futureInput", opaque: [1, 2] }] }));
  expect(await screen.findByText("Edited")).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit queued message" })).not.toBeInTheDocument());
  const handle = within(screen.getAllByRole("group", { name: "Queued message" })[1]).getByRole("button", { name: "Reorder queued message" });
  // The refreshed text can appear before the save operation re-enables controls.
  await waitFor(() => expect(handle).toBeEnabled());
  handle.focus();
  expect(handle).toHaveFocus();
  await userEvent.keyboard("{ArrowUp}");
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[1]).toEqual({ queuedSubmissionIds: ["a", "b"] });
  await waitFor(() => expect(screen.getAllByRole("group", { name: "Queued message" })[0]).toHaveTextContent("a"));
});

it.each<QueueTransfer["phase"]>(["deleting", "deleted", "steering", "accepted"])("keeps %s transfers in authoritative cache without showing recovery controls", async (phase) => {
  const transfer = saved(phase);
  mockGateway({ "GET /v1/threads/chat/queued-inputs": { queuedInputs: [], transfers: [transfer], nextCursor: null } });
  const client = mount();
  await waitFor(() => expect(client.getQueryData(queryKeys.queuedInputs("chat"))).toMatchObject({ transfers: [transfer] }));
  expect(screen.queryByRole("region", { name: "Queue transfers" })).not.toBeInTheDocument();
  expect(screen.queryByText("Saved correction")).not.toBeInTheDocument();
});

it("reveals uncertain delivery recovery and restores text only after an explicit warning without resending", async () => {
  let transfer = saved("accepted");
  const gateway = mockGateway({
    "GET /v1/threads/chat/queued-inputs": () => ({ queuedInputs: [], transfers: [transfer], nextCursor: null }),
    "POST /v1/queue-transfers/transfer/reconcile": () => ({ status: "transfer", transfer }),
  });
  const restore = vi.fn();
  const client = mount(restore);
  await waitFor(() => expect(client.getQueryData(queryKeys.queuedInputs("chat"))).toMatchObject({ transfers: [transfer] }));
  expect(screen.queryByRole("region", { name: "Queue transfers" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Dismiss" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  transfer = saved("uncertain");
  applyQueueEvent(client, { id: "2", seq: 2, kind: "turn_queue.transfer_changed", threadId: "chat", payload: { threadId: "chat" }, receivedAt: "2026-10-05T00:00:00Z" });
  expect(await screen.findByText("Delivery uncertain")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Restore to composer" }));
  expect(screen.getByRole("dialog", { name: "Restore saved input" })).toHaveTextContent("may already have been delivered");
  expect(restore).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Restore text" }));
  expect(restore).toHaveBeenCalledWith("Saved correction");
  expect(gateway.calls.filter((request) => request.method !== "GET")).toHaveLength(0);
  await userEvent.click(screen.getByRole("button", { name: "Reconcile" }));
  await waitFor(() => expect(gateway.callsFor("POST", "/v1/queue-transfers/transfer/reconcile")).toHaveLength(1));
  expect(screen.getByRole("button", { name: "Dismiss" })).toBeEnabled();
});
