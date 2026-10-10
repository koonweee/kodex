import assert from "node:assert/strict";
import { test } from "node:test";
import { Session, type MastraDBMessage } from "@mastra/core/agent-controller";
import type { MastraCodeState } from "@mastra/code-sdk/schema";
import { createSessionProjection } from "../src/transport.js";

function nativeSession() {
  return new Session<MastraCodeState>({
    id: "fencing-session", resourceId: "fencing-resource", ownerId: "fencing-owner",
  });
}

test("a coalesced native text mutation fences an overlapping history response", async (t) => {
  const session = nativeSession();
  const projection = createSessionProjection(session);
  t.after(() => projection.dispose());
  let displayNotifications = 0;
  const unsubscribe = session.subscribe(event => {
    if (event.type === "display_state_changed") displayNotifications++;
  });
  t.after(unsubscribe);
  session.emit({ type: "agent_start" });
  const message: MastraDBMessage = {
    id: "live-message", role: "assistant", createdAt: new Date(),
    content: { format: 2, parts: [{ type: "text", text: "before" }] },
  };
  session.emit({ type: "message_start", message });
  // The leading delta opens the SDK's 16ms display-coalescing window.
  session.emit({ type: "message_update", id: message.id, event: { type: "text-delta", delta: ":leading" } });
  const before = await projection.snapshot();
  const notificationsBefore = displayNotifications;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let firstRead = true;
  const currentMessages: MastraDBMessage[] = [{
    ...message, content: { format: 2, parts: [{ type: "text", text: "current-history" }] },
  }];
  t.mock.method(session.thread, "listActiveMessages", async () => {
    if (firstRead) {
      firstRead = false;
      await gate;
      return [];
    }
    return currentMessages;
  });
  const overlapping = projection.snapshot();
  session.emit({ type: "message_update", id: message.id, event: { type: "text-delta", delta: ":coalesced" } });
  assert.equal(displayNotifications, notificationsBefore, "native display notification is still withheld");
  release();
  const captured = await overlapping;
  assert.ok(captured.revision > before.revision, "native mutation advances snapshot coverage before its batched notification");
  assert.deepEqual(captured.messages, currentMessages, "the pre-mutation history reply cannot claim current snapshot coverage");
  assert.equal(captured.display.currentMessage?.content.parts.find(part => part.type === "text")?.text, "before:leading:coalesced");
});

test("projection disposal invalidates a history read that is already in flight", async (t) => {
  const session = nativeSession();
  const projection = createSessionProjection(session);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(session.thread, "listActiveMessages", async () => { await gate; return []; });
  const pending = projection.snapshot();
  projection.dispose();
  release();
  await assert.rejects(pending, { name: "AbortError" });
});
