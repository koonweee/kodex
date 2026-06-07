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
        submitAvailable: true,
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

  it("receives parent-scoped subagent SSE events emitted by the gateway", () => {
    const received: string[] = [];
    const client = createEventStreamClient({
      EventSourceCtor: FakeEventSource,
      threadId: "thread-1",
      onEvent: (event) => received.push(event.kind),
    });

    client.connect();
    FakeEventSource.instances[0].emitNamed("thread.subagent_started", {
      id: "event-9",
      seq: 9,
      kind: "thread.subagent_started",
      codexMethod: "thread/subagent",
      itemId: null,
      threadId: "thread-1",
      turnId: null,
      projectId: null,
      payload: { parentThreadId: "thread-1", subagentId: "subagent-1", subagent: null },
      receivedAt: "2026-04-30T00:00:00Z",
    });

    expect(received).toEqual(["thread.subagent_started"]);
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
