import { afterEach, describe, expect, it, vi } from "vitest";

import { createEventStreamClient } from "./stream";

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  private listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  closed = false;

  constructor(public readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  emit(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent<string>);
  }

  emitNamed(type: string, payload: unknown) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(payload) } as MessageEvent<string>);
    }
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

  it("starts fresh streams without a replay cursor", () => {
    const client = createEventStreamClient({
      EventSourceCtor: FakeEventSource,
      threadId: "thread-1",
      onEvent: () => {},
    });

    client.connect();

    expect(FakeEventSource.instances[0].url).toContain("/v1/events?threadId=thread-1");
    expect(FakeEventSource.instances[0].url).not.toContain("cursor=");
    client.close();
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

  it("receives live thread metadata notification events emitted by the gateway", () => {
    const received: string[] = [];
    const client = createEventStreamClient({
      EventSourceCtor: FakeEventSource,
      threadId: "thread-1",
      onEvent: (event) => received.push(event.codexMethod ?? event.kind),
    });

    client.connect();
    FakeEventSource.instances[0].emitNamed("codex.notification", {
      id: "event-7",
      seq: 7,
      kind: "codex.notification",
      codexMethod: "thread/nameUpdated",
      itemId: null,
      threadId: "thread-1",
      turnId: null,
      projectId: "project-1",
      payload: { threadId: "thread-1", threadName: "New title" },
      receivedAt: "2026-04-30T00:00:00Z",
    });

    expect(received).toEqual(["thread/nameUpdated"]);
    client.close();
  });

  it("receives normalized timeline SSE events emitted by the gateway", () => {
    const received: string[] = [];
    const client = createEventStreamClient({
      EventSourceCtor: FakeEventSource,
      threadId: "thread-1",
      onEvent: (event) => received.push(event.kind),
    });

    client.connect();
    FakeEventSource.instances[0].emitNamed("timeline.item_delta", {
      id: "event-8",
      seq: 8,
      kind: "timeline.item_delta",
      codexMethod: "item/agentMessage/delta",
      itemId: "item-1",
      threadId: "thread-1",
      turnId: "turn-1",
      projectId: null,
      payload: { source: "gatewayStream", delta: "Hi", rawPayload: { delta: "Hi" } },
      receivedAt: "2026-04-30T00:00:00Z",
    });

    expect(received).toEqual(["timeline.item_delta"]);
    client.close();
  });

  it("receives gateway thread pin update events", () => {
    const received: string[] = [];
    const client = createEventStreamClient({
      EventSourceCtor: FakeEventSource,
      threadId: "thread-1",
      onEvent: (event) => received.push(event.kind),
    });

    client.connect();
    FakeEventSource.instances[0].emitNamed("thread.pin_updated", {
      id: "event-9",
      seq: 9,
      kind: "thread.pin_updated",
      codexMethod: null,
      itemId: null,
      threadId: "thread-1",
      turnId: null,
      projectId: null,
      payload: { threadId: "thread-1", pinnedAt: "2026-05-06T12:00:00Z" },
      receivedAt: "2026-04-30T00:00:00Z",
    });

    expect(received).toEqual(["thread.pin_updated"]);
    client.close();
  });

  it("receives gateway skill invalidation events", () => {
    const received: string[] = [];
    const client = createEventStreamClient({
      EventSourceCtor: FakeEventSource,
      onEvent: (event) => received.push(event.kind),
    });

    client.connect();
    FakeEventSource.instances[0].emitNamed("skills.changed", {
      id: "event-10",
      seq: 10,
      kind: "skills.changed",
      codexMethod: "skills/changed",
      itemId: null,
      threadId: null,
      turnId: null,
      projectId: null,
      payload: { generation: 1, source: "app-server" },
      receivedAt: "2026-04-30T00:00:00Z",
    });

    expect(received).toEqual(["skills.changed"]);
    client.close();
  });

  it("receives gateway MCP lifecycle events", () => {
    const received: string[] = [];
    const client = createEventStreamClient({
      EventSourceCtor: FakeEventSource,
      onEvent: (event) => received.push(event.kind),
    });

    client.connect();
    FakeEventSource.instances[0].emitNamed("mcp.config_changed", {
      id: "event-10",
      seq: 10,
      kind: "mcp.config_changed",
      codexMethod: null,
      itemId: null,
      threadId: null,
      turnId: null,
      projectId: null,
      payload: { operation: "add", server: "docs" },
      receivedAt: "2026-04-30T00:00:00Z",
    });
    FakeEventSource.instances[0].emitNamed("mcp.server_status_updated", {
      id: "event-11",
      seq: 11,
      kind: "mcp.server_status_updated",
      codexMethod: "mcpServer/startupStatus/updated",
      itemId: null,
      threadId: null,
      turnId: null,
      projectId: null,
      payload: { name: "docs", status: "ready", error: null },
      receivedAt: "2026-04-30T00:00:00Z",
    });
    FakeEventSource.instances[0].emitNamed("mcp.oauth_login_completed", {
      id: "event-12",
      seq: 12,
      kind: "mcp.oauth_login_completed",
      codexMethod: "mcpServer/oauthLogin/completed",
      itemId: null,
      threadId: null,
      turnId: null,
      projectId: null,
      payload: { name: "docs", success: true, error: null },
      receivedAt: "2026-04-30T00:00:00Z",
    });

    expect(received).toEqual(["mcp.config_changed", "mcp.server_status_updated", "mcp.oauth_login_completed"]);
    client.close();
  });

  it("delivers skill invalidation events to two stream clients", () => {
    const first: string[] = [];
    const second: string[] = [];
    const clientA = createEventStreamClient({
      EventSourceCtor: FakeEventSource,
      onEvent: (event) => first.push(event.kind),
    });
    const clientB = createEventStreamClient({
      EventSourceCtor: FakeEventSource,
      onEvent: (event) => second.push(event.kind),
    });

    clientA.connect();
    clientB.connect();
    const payload = {
      id: "event-11",
      seq: 11,
      kind: "skills.changed",
      codexMethod: "skills/changed",
      itemId: null,
      threadId: null,
      turnId: null,
      projectId: null,
      payload: { generation: 2, source: "app-server" },
      receivedAt: "2026-04-30T00:00:00Z",
    };
    FakeEventSource.instances[0].emitNamed("skills.changed", payload);
    FakeEventSource.instances[1].emitNamed("skills.changed", payload);

    expect(first).toEqual(["skills.changed"]);
    expect(second).toEqual(["skills.changed"]);
    clientA.close();
    clientB.close();
  });
});
