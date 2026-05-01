import { afterEach, describe, expect, it, vi } from "vitest";

import { createEventStreamClient } from "./stream";

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  closed = false;

  constructor(public readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
  }

  emit(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent<string>);
  }

  fail() {
    this.onerror?.();
  }
}

describe("event stream client", () => {
  afterEach(() => {
    vi.useRealTimers();
    FakeEventSource.instances = [];
  });

  it("reconnects from the last seen sequence", () => {
    vi.useFakeTimers();
    const received: number[] = [];
    const client = createEventStreamClient({
      EventSourceCtor: FakeEventSource,
      reconnectDelayMs: 250,
      threadId: "thread-1",
      cursor: 5,
      onEvent: (event) => received.push(event.seq),
    });

    client.connect();
    expect(FakeEventSource.instances[0].url).toContain("/v1/events?cursor=5&threadId=thread-1");

    FakeEventSource.instances[0].emit({
      id: "event-6",
      seq: 6,
      kind: "codex",
      codexMethod: "item/agentMessage/delta",
      itemId: "item-1",
      threadId: "thread-1",
      turnId: "turn-1",
      projectId: "project-1",
      payload: { delta: "Hi" },
      receivedAt: "2026-04-30T00:00:00Z",
    });
    FakeEventSource.instances[0].fail();
    vi.advanceTimersByTime(250);

    expect(received).toEqual([6]);
    expect(FakeEventSource.instances[0].closed).toBe(true);
    expect(FakeEventSource.instances[1].url).toContain("/v1/events?cursor=6&threadId=thread-1");

    client.close();
    expect(FakeEventSource.instances[1].closed).toBe(true);
  });
});
