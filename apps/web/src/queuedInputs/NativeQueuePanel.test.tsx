import { MantineProvider } from "@mantine/core";
import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { createKodexQueryClient } from "../api/queryClient";
import { queryKeys } from "../api/queryKeys";
import type { QueueTransfer } from "../api/client";
import { mockGateway, requestJson } from "../test/gatewayMock";
import { appendResponseAnnotations } from "../composer/annotations";
import { NativeQueuePanel } from "./NativeQueuePanel";
import { useNativeQueue } from "./useNativeQueue";
import { applyQueueEvent } from "./cache";

afterEach(() => vi.restoreAllMocks());
const row = (id: string, canSteer = false) => ({ id, threadId: "chat", clientUserMessageId: "reusable", input: [{ type: "text", text: id }], attachments: [], canSteer });
const saved = (phase: QueueTransfer["phase"]): QueueTransfer => ({ id: "transfer", threadId: "chat", nativeQueueId: "b", clientUserMessageId: "reusable", expectedTurnId: "turn", input: [{ type: "text", text: "Saved correction" }], phase, error: phase === "uncertain" ? "Acknowledgement lost" : null, createdAt: "2026-10-05T00:00:00Z", updatedAt: "2026-10-05T00:00:00Z" });
function mount(onRestoreText = vi.fn()) {
  const client = createKodexQueryClient();
  function Panel() {
    const queue = useNativeQueue("chat");
    return <NativeQueuePanel threadId="chat" queue={queue} canRestoreText onRestoreText={onRestoreText} />;
  }
  render(<QueryClientProvider client={client}><MantineProvider env="test"><Panel /></MantineProvider></QueryClientProvider>);
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

it("edits queued response annotations without exposing their serialized markup", async () => {
  const original = appendResponseAnnotations("Review this", [{ id: "quote", text: "Selected answer", comment: "Old note" }]);
  const queued = { ...row("annotated"), input: [{ type: "text", text: original, nativeKey: "keep" }, { type: "futureInput", opaque: [1, 2] }] };
  const writes: unknown[] = [];
  mockGateway({
    "GET /v1/threads/chat/queued-inputs": { queuedInputs: [queued], transfers: [], nextCursor: null },
    "PUT /v1/threads/chat/queued-inputs/annotated": async (request: Request) => {
      const body = await requestJson(request);
      writes.push(body);
      return { queuedInput: { ...queued, input: body.input } };
    },
  });
  mount();
  const group = await screen.findByRole("group", { name: "Queued message" });
  await userEvent.click(within(group).getByRole("button", { name: "Edit" }));
  expect(screen.getByRole("textbox", { name: "Queued message text" })).toHaveValue("Review this");
  expect(screen.getByText("Selected answer")).toBeInTheDocument();
  await userEvent.clear(screen.getByRole("textbox", { name: "Annotation 1 comment" }));
  await userEvent.type(screen.getByRole("textbox", { name: "Annotation 1 comment" }), "New note");
  await userEvent.click(screen.getByRole("button", { name: "Save queued message" }));
  await waitFor(() => expect(writes).toEqual([{ input: [
    { type: "text", text: appendResponseAnnotations("Review this", [{ id: "quote", text: "Selected answer", comment: "New note" }]), nativeKey: "keep", text_elements: [] },
    { type: "futureInput", opaque: [1, 2] },
  ] }]));
});

it("removes a queued annotation while leaving the main text editable", async () => {
  const original = appendResponseAnnotations("Keep the main text", [{ id: "quote", text: "Selected answer", comment: "Remove this" }]);
  const queued = { ...row("annotated"), input: [{ type: "text", text: original }] };
  const writes: unknown[] = [];
  mockGateway({
    "GET /v1/threads/chat/queued-inputs": { queuedInputs: [queued], transfers: [], nextCursor: null },
    "PUT /v1/threads/chat/queued-inputs/annotated": async (request: Request) => {
      const body = await requestJson(request);
      writes.push(body);
      return { queuedInput: { ...queued, input: body.input } };
    },
  });
  mount();
  await userEvent.click(within(await screen.findByRole("group", { name: "Queued message" })).getByRole("button", { name: "Edit" }));
  await userEvent.click(screen.getByRole("button", { name: "Save queued message" }));
  await waitFor(() => expect(writes[0]).toEqual({ input: queued.input }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit queued message" })).not.toBeInTheDocument());
  await userEvent.click(within(screen.getByRole("group", { name: "Queued message" })).getByRole("button", { name: "Edit" }));
  await userEvent.click(screen.getByRole("button", { name: "Remove annotation 1" }));
  expect(screen.queryByRole("textbox", { name: "Annotation 1 comment" })).not.toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Queued message text" })).toHaveValue("Keep the main text");
  await userEvent.click(screen.getByRole("button", { name: "Save queued message" }));
  await waitFor(() => expect(writes[1]).toEqual({ input: [{ type: "text", text: "Keep the main text", text_elements: [] }] }));
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
