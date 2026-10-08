import { afterEach, describe, expect, it, vi } from "vitest";

import type { EventEnvelope } from "../api/client";
import { createEventStreamClient } from "./stream";

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  private listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
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

  open() {
    this.onopen?.();
  }
}

describe("event stream client", () => {
  afterEach(() => {
    vi.useRealTimers();
    FakeEventSource.instances = [];
  });

  it("changes delivery flags without losing the cursor or reporting a network reconnect", () => {
    vi.useFakeTimers();
    const onStatusChange = vi.fn();
    const client = createEventStreamClient({ EventSourceCtor: FakeEventSource, cursor: 4, onEvent: vi.fn(), onStatusChange, reconnectDelayMs: 250 });
    client.connect();
    FakeEventSource.instances[0].open();
    FakeEventSource.instances[0].emit({ seq: 9 });
    client.updateDeliveryOptions({ includeDebugEvents: true, includeCommandOutputs: true });
    const changed = FakeEventSource.instances[1];
    const url = new URL(changed.url, window.location.origin);
    expect(FakeEventSource.instances[0].closed).toBe(true);
    expect(url.searchParams.get("cursor")).toBe("9");
    expect(url.searchParams.get("includeDebugEvents")).toBe("true");
    expect(url.searchParams.get("includeCommandOutputs")).toBe("true");
    changed.open();
    expect(onStatusChange).toHaveBeenLastCalledWith("connected", "delivery_options");
    expect(onStatusChange.mock.calls.some(([status]) => status === "reconnecting")).toBe(false);
    changed.fail();
    vi.advanceTimersByTime(250);
    expect(onStatusChange).toHaveBeenLastCalledWith("reconnecting");
    client.close();
  });

  it("still reports network recovery if delivery options change during a retry", () => {
    vi.useFakeTimers();
    const onStatusChange = vi.fn();
    const client = createEventStreamClient({ EventSourceCtor: FakeEventSource, onEvent: vi.fn(), onStatusChange, reconnectDelayMs: 250 });
    client.connect();
    FakeEventSource.instances[0].open();
    FakeEventSource.instances[0].fail();
    client.updateDeliveryOptions({ includeCommandOutputs: true });
    expect(onStatusChange).toHaveBeenLastCalledWith("reconnecting");
    FakeEventSource.instances[1].open();
    expect(onStatusChange).toHaveBeenLastCalledWith("connected");
    vi.advanceTimersByTime(250);
    expect(FakeEventSource.instances).toHaveLength(2);
    client.close();
  });

  it("preserves normal recovery when flags change twice before the replacement stream opens", () => {
    vi.useFakeTimers();
    const onStatusChange = vi.fn();
    const client = createEventStreamClient({ EventSourceCtor: FakeEventSource, onEvent: vi.fn(), onStatusChange, reconnectDelayMs: 250 });
    client.connect();
    FakeEventSource.instances[0].open();
    FakeEventSource.instances[0].emit({ seq: 7 });
    FakeEventSource.instances[0].fail();
    vi.advanceTimersByTime(250);
    const recovering = FakeEventSource.instances[1];
    client.updateDeliveryOptions({ includeCommandOutputs: true });
    const firstReplacement = FakeEventSource.instances[2];
    client.updateDeliveryOptions({ includeCommandOutputs: true, includeDebugEvents: true });
    recovering.open();
    firstReplacement.open();
    const latest = FakeEventSource.instances[3];
    latest.open();
    expect(onStatusChange).toHaveBeenLastCalledWith("connected");
    expect(onStatusChange.mock.calls.filter(([status]) => status === "connected")).toHaveLength(2);
    const url = new URL(latest.url, window.location.origin);
    expect(url.searchParams.get("cursor")).toBe("7");
    expect(url.searchParams.get("includeCommandOutputs")).toBe("true");
    expect(url.searchParams.get("includeDebugEvents")).toBe("true");
    client.close();
  });

  it("keeps initial connected recovery if flags change before the first stream opens", () => {
    const onStatusChange = vi.fn();
    const client = createEventStreamClient({ EventSourceCtor: FakeEventSource, onEvent: vi.fn(), onStatusChange });
    client.connect();
    client.updateDeliveryOptions({ includeCommandOutputs: true });
    FakeEventSource.instances[0].open();
    expect(onStatusChange).not.toHaveBeenCalled();
    FakeEventSource.instances[1].open();
    expect(onStatusChange).toHaveBeenCalledWith("connected");
    client.close();
  });

  it("uses ordinary connected recovery when toggling before the first event establishes a replay cursor", () => {
    const onStatusChange = vi.fn();
    const client = createEventStreamClient({ EventSourceCtor: FakeEventSource, onEvent: vi.fn(), onStatusChange });
    client.connect();
    FakeEventSource.instances[0].open();
    client.updateDeliveryOptions({ includeCommandOutputs: true });
    const replacement = FakeEventSource.instances[1];
    expect(new URL(replacement.url, window.location.origin).searchParams.has("cursor")).toBe(false);
    replacement.open();
    expect(onStatusChange.mock.calls).toEqual([["connected"], ["connected"]]);
    client.close();
  });

  it("keeps delivery preferences independent between clients", () => {
    const first = createEventStreamClient({ EventSourceCtor: FakeEventSource, onEvent: vi.fn() });
    const second = createEventStreamClient({ EventSourceCtor: FakeEventSource, onEvent: vi.fn() });
    first.connect(); second.connect();
    first.updateDeliveryOptions({ includeDebugEvents: true, includeCommandOutputs: true });
    expect(FakeEventSource.instances[1].closed).toBe(false);
    expect(new URL(FakeEventSource.instances[1].url, window.location.origin).searchParams.has("includeCommandOutputs")).toBe(false);
    first.close(); second.close();
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

  it("waits for identity validation before connecting and cannot reopen after close", async () => {
    let resolve!: (allowed: boolean) => void;
    const beforeConnect = vi.fn(() => new Promise<boolean>((done) => { resolve = done; }));
    const client = createEventStreamClient({
      EventSourceCtor: FakeEventSource,
      beforeConnect,
      cursor: 70,
      threadId: "old-thread",
      onEvent: vi.fn(),
    });

    client.connect();
    expect(beforeConnect).toHaveBeenCalledTimes(1);
    expect(FakeEventSource.instances).toHaveLength(0);
    client.close();
    resolve(true);
    await Promise.resolve();

    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("gates replay and snapshot recovery on identity validation and ignores the disconnected source", async () => {
    vi.useFakeTimers();
    let resolve!: (allowed: boolean) => void;
    const beforeConnect = vi.fn()
      .mockResolvedValueOnce(true)
      .mockImplementationOnce(() => new Promise<boolean>((done) => { resolve = done; }));
    const onEvent = vi.fn();
    const onStatusChange = vi.fn();
    const client = createEventStreamClient({
      EventSourceCtor: FakeEventSource,
      beforeConnect,
      cursor: 5,
      onEvent,
      onStatusChange,
      reconnectDelayMs: 250,
      threadId: "thread-1",
    });
    client.connect();
    await Promise.resolve();
    const first = FakeEventSource.instances[0];
    expect(onStatusChange).not.toHaveBeenCalled();
    first.open();
    first.emit({ seq: 6 });
    first.fail();
    first.emit({ seq: 100 });
    first.open();
    await vi.advanceTimersByTimeAsync(250);

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onStatusChange.mock.calls).toEqual([["connected"]]);
    expect(FakeEventSource.instances).toHaveLength(1);
    resolve(true);
    await Promise.resolve();

    expect(onStatusChange.mock.calls).toEqual([["connected"], ["reconnecting"]]);
    expect(FakeEventSource.instances).toHaveLength(2);
    FakeEventSource.instances[1].open();
    expect(onStatusChange.mock.calls).toEqual([["connected"], ["reconnecting"], ["connected"]]);
    expect(new URL(FakeEventSource.instances[1].url, window.location.origin).searchParams.get("cursor")).toBe("6");
    client.close();
  });

  it("retries a failed identity check without connecting or starting snapshot recovery", async () => {
    vi.useFakeTimers();
    const beforeConnect = vi.fn().mockRejectedValueOnce(new Error("Offline")).mockResolvedValueOnce(true);
    const onStatusChange = vi.fn();
    const client = createEventStreamClient({
      EventSourceCtor: FakeEventSource,
      beforeConnect,
      cursor: 5,
      onEvent: vi.fn(),
      onStatusChange,
      reconnectDelayMs: 250,
    });
    client.connect();
    await vi.advanceTimersByTimeAsync(0);

    expect(FakeEventSource.instances).toHaveLength(0);
    expect(onStatusChange).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);

    expect(beforeConnect).toHaveBeenCalledTimes(2);
    expect(FakeEventSource.instances).toHaveLength(1);
    client.close();
  });


  it("starts workspace streams with deduped thread ids and global events", () => {
    const client = createEventStreamClient({
      EventSourceCtor: FakeEventSource,
      includeGlobal: true,
      threadIds: ["thread-1", "thread-1", " thread-2 "],
      onEvent: () => {},
    });

    client.connect();

    const url = new URL(FakeEventSource.instances[0].url, window.location.origin);
    expect(url.pathname).toBe("/v1/events");
    expect(url.searchParams.get("includeGlobal")).toBe("true");
    expect(url.searchParams.get("threadIds")).toBe("thread-1,thread-2");
    expect(url.searchParams.has("threadId")).toBe(false);
    client.close();
  });

  it("preserves workspace stream filters across reconnects", () => {
    vi.useFakeTimers();
    const client = createEventStreamClient({
      EventSourceCtor: FakeEventSource,
      includeGlobal: true,
      reconnectDelayMs: 250,
      threadIds: ["thread-1", "thread-2"],
      cursor: 5,
      onEvent: () => {},
    });

    client.connect();
    FakeEventSource.instances[0].emit({
      id: "event-6",
      seq: 6,
      kind: "workspace.updated",
      codexMethod: null,
      itemId: null,
      threadId: null,
      turnId: null,
      projectId: null,
      payload: { workspaceId: "default" },
      receivedAt: "2026-04-30T00:00:00Z",
    });
    FakeEventSource.instances[0].fail();
    vi.advanceTimersByTime(250);

    const url = new URL(FakeEventSource.instances[1].url, window.location.origin);
    expect(url.searchParams.get("cursor")).toBe("6");
    expect(url.searchParams.get("includeGlobal")).toBe("true");
    expect(url.searchParams.get("threadIds")).toBe("thread-1,thread-2");
    client.close();
  });

  it("starts global streams with a selected-thread exclusion", () => {
    const client = createEventStreamClient({
      EventSourceCtor: FakeEventSource,
      excludeThreadId: "thread-1",
      onEvent: () => {},
    });

    client.connect();

    expect(FakeEventSource.instances[0].url).toContain("/v1/events?excludeThreadId=thread-1");
    expect(FakeEventSource.instances[0].url).not.toContain("threadId=");
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

  it("preserves selected-thread exclusion across reconnects", () => {
    vi.useFakeTimers();
    const client = createEventStreamClient({
      EventSourceCtor: FakeEventSource,
      reconnectDelayMs: 250,
      excludeThreadId: "thread-1",
      cursor: 5,
      onEvent: () => {},
    });

    client.connect();
    FakeEventSource.instances[0].emit({
      id: "event-6",
      seq: 6,
      kind: "thread.read_updated",
      codexMethod: null,
      itemId: null,
      threadId: "thread-2",
      turnId: null,
      projectId: "project-1",
      payload: { threadId: "thread-2" },
      receivedAt: "2026-04-30T00:00:00Z",
    });
    FakeEventSource.instances[0].fail();
    vi.advanceTimersByTime(250);

    expect(FakeEventSource.instances[1].url).toContain("cursor=6");
    expect(FakeEventSource.instances[1].url).toContain("excludeThreadId=thread-1");
    client.close();
  });

  it("receives live thread metadata notification events emitted by the gateway", () => {
    const received: string[] = [];
    const client = createEventStreamClient({
      EventSourceCtor: FakeEventSource,
      threadId: "thread-1",
      onEvent: (event) => received.push(event.codexMethod ?? event.kind),
    });

    client.connect();
    FakeEventSource.instances[0].emitNamed("timeline.thread_metadata", {
      id: "event-7",
      seq: 7,
      kind: "timeline.thread_metadata",
      codexMethod: "thread/name/updated",
      itemId: null,
      threadId: "thread-1",
      turnId: null,
      projectId: "project-1",
      payload: { threadId: "thread-1", threadName: "New title" },
      receivedAt: "2026-04-30T00:00:00Z",
    });

    expect(received).toEqual(["thread/name/updated"]);
    client.close();
  });

  it.each(["thread.settings_updated", "thread.goal_changed", "thread.summary_changed"])("receives %s as a named SSE refill event", (kind) => {
    const received: EventEnvelope[] = [];
    const client = createEventStreamClient({ EventSourceCtor: FakeEventSource, onEvent: (event) => received.push(event) });
    client.connect();
    const marker = { id: "refill", seq: 8, kind, threadId: "thread-1", payload: { threadId: "thread-1" }, receivedAt: "2026-10-04T00:00:00Z" };
    FakeEventSource.instances[0].emitNamed(marker.kind, marker);
    expect(received).toEqual([marker]);
    client.close();
  });

  it("receives canonical timeline patch SSE events emitted by the gateway", () => {
    const received: string[] = [];
    const client = createEventStreamClient({
      EventSourceCtor: FakeEventSource,
      threadId: "thread-1",
      onEvent: (event) => received.push(event.kind),
    });

    client.connect();
    FakeEventSource.instances[0].emitNamed("thread_view.patch", {
      id: "event-8",
      seq: 8,
      kind: "thread_view.patch",
      codexMethod: "thread_view/patch",
      itemId: null,
      threadId: "thread-1",
      turnId: "turn-1",
      projectId: null,
      payload: {
        scope: "lifecycle",
        viewRevision: 8,
        threadId: "thread-1",
        activeTurnId: "turn-1",
        liveState: "streaming",
        pendingApprovalRequests: [],
        pendingUserInputRequests: [],
        items: [],
        turns: [],
      },
      receivedAt: "2026-04-30T00:00:00Z",
    });

    expect(received).toEqual(["thread_view.patch"]);
    client.close();
  });

  it("receives app surface SSE events emitted by the gateway", () => {
    const received: string[] = [];
    const client = createEventStreamClient({
      EventSourceCtor: FakeEventSource,
      threadId: "thread-1",
      onEvent: (event) => received.push(event.kind),
    });

    client.connect();
    FakeEventSource.instances[0].emitNamed("app_surface.session_upserted", {
      id: "event-9",
      seq: 9,
      kind: "app_surface.session_upserted",
      codexMethod: null,
      itemId: null,
      threadId: "thread-1",
      turnId: null,
      projectId: null,
      payload: {
        id: "session-1",
        threadId: "thread-1",
        title: "Mockups",
        revision: 1,
        status: "active",
        documentUrl: "/v1/app-surfaces/session-1/document?revision=1",
        csp: { connectDomains: [], resourceDomains: [] },
        displayModes: ["pane"],
        fallbackContent: "Mockups",
        grants: { canOpenLinks: false, canSendMessage: true, canUpdateModelContext: false, resources: [], tools: [] },
        bridgeToken: "bridge-token-1",
        provenance: { source: "test" },
        provider: "generated",
        resourceMimeType: "text/html",
        resourceUri: "ui://kodex/generated/session-1",
        createdAt: "2026-04-30T00:00:00Z",
        updatedAt: "2026-04-30T00:00:00Z",
      },
      receivedAt: "2026-04-30T00:00:00Z",
    });

    expect(received).toEqual(["app_surface.session_upserted"]);
    client.close();
  });

  it("receives app surface presentation request SSE events emitted by the gateway", () => {
    const received: string[] = [];
    const client = createEventStreamClient({
      EventSourceCtor: FakeEventSource,
      threadId: "thread-1",
      onEvent: (event) => received.push(event.kind),
    });

    client.connect();
    FakeEventSource.instances[0].emitNamed("app_surface.presentation_requested", {
      id: "event-10",
      seq: 10,
      kind: "app_surface.presentation_requested",
      codexMethod: null,
      itemId: null,
      threadId: "thread-1",
      turnId: null,
      projectId: null,
      payload: {
        action: "focus",
        sessionId: "session-1",
        threadId: "thread-1",
        title: "Mockups",
      },
      receivedAt: "2026-04-30T00:00:00Z",
    });

    expect(received).toEqual(["app_surface.presentation_requested"]);
    client.close();
  });

  it("receives global native subagent invalidation markers", () => {
    const received: string[] = [];
    const client = createEventStreamClient({
      EventSourceCtor: FakeEventSource,
      includeGlobal: true,
      onEvent: (event) => received.push(event.kind),
    });

    client.connect();
    FakeEventSource.instances[0].emitNamed("thread.subagents_changed", {
      id: "event-9",
      seq: 9,
      kind: "thread.subagents_changed",
      codexMethod: null,
      itemId: null,
      threadId: null,
      turnId: null,
      projectId: null,
      payload: { changedThreadId: null },
      receivedAt: "2026-04-30T00:00:00Z",
    });

    expect(received).toEqual(["thread.subagents_changed"]);
    client.close();
  });

  it("receives canonical thread view item delta events", () => {
    const received: string[] = [];
    const client = createEventStreamClient({
      EventSourceCtor: FakeEventSource,
      threadId: "thread-1",
      onEvent: (event) => received.push(`${event.kind}:${event.payload && typeof event.payload === "object" && "delta" in event.payload ? event.payload.delta : ""}`),
    });

    client.connect();
    FakeEventSource.instances[0].emitNamed("thread_view.item_delta", {
      id: "event-8",
      seq: 8,
      kind: "thread_view.item_delta",
      codexMethod: "thread_view/item_delta",
      itemId: "item-1",
      threadId: "thread-1",
      turnId: "turn-1",
      projectId: null,
      payload: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "Hello", viewRevision: 8 },
      receivedAt: "2026-04-30T00:00:00Z",
    });

    expect(received).toEqual(["thread_view.item_delta:Hello"]);
    client.close();
  });

  it("does not subscribe to raw compact live timeline delta events", () => {
    const received: string[] = [];
    const client = createEventStreamClient({
      EventSourceCtor: FakeEventSource,
      threadId: "thread-1",
      onEvent: (event) => received.push(`${event.kind}:${event.payload && typeof event.payload === "object" && "delta" in event.payload ? event.payload.delta : ""}`),
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
      payload: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "Hello" },
      receivedAt: "2026-04-30T00:00:00Z",
    });

    expect(received).toEqual([]);
    client.close();
  });

  it("receives native pin invalidation events", () => {
    const received: string[] = [];
    const client = createEventStreamClient({
      EventSourceCtor: FakeEventSource,
      threadId: "thread-1",
      onEvent: (event) => received.push(event.kind),
    });

    client.connect();
    FakeEventSource.instances[0].emitNamed("thread.pins_updated", {
      id: "event-9",
      seq: 9,
      kind: "thread.pins_updated",
      codexMethod: null,
      itemId: null,
      threadId: "thread-1",
      turnId: null,
      projectId: null,
      payload: {},
      receivedAt: "2026-04-30T00:00:00Z",
    });

    expect(received).toEqual(["thread.pins_updated"]);
    client.close();
  });

  it("receives gateway error diagnostic events", () => {
    const received: string[] = [];
    const client = createEventStreamClient({
      EventSourceCtor: FakeEventSource,
      threadId: "thread-1",
      onEvent: (event) => received.push(event.kind),
    });

    client.connect();
    FakeEventSource.instances[0].emitNamed("gateway.error", {
      id: "event-error",
      seq: 9,
      kind: "gateway.error",
      codexMethod: null,
      itemId: "error-1",
      threadId: "thread-1",
      turnId: "turn-1",
      projectId: null,
      payload: { message: "Selected error routed" },
      receivedAt: "2026-04-30T00:00:00Z",
    });

    expect(received).toEqual(["gateway.error"]);
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
    FakeEventSource.instances[0].emitNamed("config.changed", {
      id: "event-10",
      seq: 10,
      kind: "config.changed",
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

    expect(received).toEqual(["config.changed", "mcp.server_status_updated", "mcp.oauth_login_completed"]);
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

  it("delivers frontend update markers as named gateway events", () => {
    const received: string[] = [];
    const client = createEventStreamClient({
      EventSourceCtor: FakeEventSource,
      includeGlobal: true,
      onEvent: (event) => received.push(event.kind),
    });

    client.connect();
    FakeEventSource.instances[0].emitNamed("frontend.updated", {
      id: "event-12",
      seq: 12,
      kind: "frontend.updated",
      codexMethod: null,
      itemId: null,
      threadId: null,
      turnId: null,
      projectId: null,
      payload: { revision: "build-123" },
      receivedAt: "2026-10-09T00:00:00Z",
    });

    expect(received).toEqual(["frontend.updated"]);
    client.close();
  });
});
