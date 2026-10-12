import { afterEach, describe, expect, it, vi } from "vitest";

import { subscribeFederationEvent } from "./federationEventSource";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("federation event source", () => {
  it("shares one browser stream across event consumers until the last unsubscribe", () => {
    const instances: FakeEventSource[] = [];
    class FakeEventSource {
      listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();
      close = vi.fn();
      constructor(readonly url: string) { instances.push(this); }
      addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      }
      emit(type: string) {
        for (const listener of this.listeners.get(type) ?? []) listener({ data: "{}" } as MessageEvent<string>);
      }
    }
    const registry = vi.fn();
    const catalog = vi.fn();
    const unsubscribeRegistry = subscribeFederationEvent({
      EventSourceCtor: FakeEventSource,
      event: "federation.executors_changed",
      listener: registry,
    });
    const unsubscribeCatalog = subscribeFederationEvent({
      EventSourceCtor: FakeEventSource,
      event: "federation.catalog_changed",
      listener: catalog,
    });

    expect(instances).toHaveLength(1);
    expect(instances[0]!.url).toBe("/v1/federation/browser-events");
    instances[0]!.emit("federation.executors_changed");
    instances[0]!.emit("federation.catalog_changed");
    expect(registry).toHaveBeenCalledOnce();
    expect(catalog).toHaveBeenCalledOnce();

    unsubscribeRegistry();
    expect(instances[0]!.close).not.toHaveBeenCalled();
    unsubscribeCatalog();
    expect(instances[0]!.close).toHaveBeenCalledOnce();
  });

  it("replays a durable initial event to a consumer that subscribes after it arrived", async () => {
    const instances: FakeEventSource[] = [];
    class FakeEventSource {
      listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();
      close = vi.fn();
      constructor(readonly url: string) { instances.push(this); }
      addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      }
      emit(type: string, data: string) {
        for (const listener of this.listeners.get(type) ?? []) listener({ data } as MessageEvent<string>);
      }
    }
    const unsubscribeRegistry = subscribeFederationEvent({
      EventSourceCtor: FakeEventSource,
      event: "federation.executors_changed",
      listener: vi.fn(),
    });
    instances[0]!.emit("federation.catalog_changed", '{"revision":7,"orderRevision":3}');
    const catalog = vi.fn();
    const unsubscribeCatalog = subscribeFederationEvent({
      EventSourceCtor: FakeEventSource,
      event: "federation.catalog_changed",
      listener: catalog,
    });

    await Promise.resolve();
    expect(catalog).toHaveBeenCalledOnce();
    expect(catalog.mock.calls[0]![0].data).toContain('"revision":7');

    unsubscribeCatalog();
    unsubscribeRegistry();
  });

  it("elects one cross-tab stream leader, replays durable state, and transfers leadership", async () => {
    const instances: CrossTabEventSource[] = [];
    class CrossTabEventSource {
      listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();
      close = vi.fn();
      constructor(readonly url: string) { instances.push(this); }
      addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      }
      emit(type: string, data: string) {
        for (const listener of this.listeners.get(type) ?? []) listener({ data } as MessageEvent<string>);
      }
    }
    class SharedBroadcastChannel {
      static channels = new Map<string, Set<SharedBroadcastChannel>>();
      private listeners = new Set<(event: MessageEvent) => void>();
      constructor(readonly name: string) {
        const channels = SharedBroadcastChannel.channels.get(name) ?? new Set();
        channels.add(this);
        SharedBroadcastChannel.channels.set(name, channels);
      }
      addEventListener(_type: string, listener: (event: MessageEvent) => void) { this.listeners.add(listener); }
      postMessage(data: unknown) {
        for (const peer of SharedBroadcastChannel.channels.get(this.name) ?? []) {
          if (peer !== this) for (const listener of peer.listeners) listener({ data } as MessageEvent);
        }
      }
      close() {
        const channels = SharedBroadcastChannel.channels.get(this.name);
        channels?.delete(this);
        if (channels?.size === 0) SharedBroadcastChannel.channels.delete(this.name);
      }
    }
    const heldLocks = new Set<string>();
    const locks = {
      request: vi.fn(async <T>(name: string, _options: LockOptions, callback: (lock: Lock | null) => T | PromiseLike<T>) => {
        if (heldLocks.has(name)) return await callback(null);
        heldLocks.add(name);
        try {
          return await callback({ name, mode: "exclusive" } as Lock);
        } finally {
          heldLocks.delete(name);
        }
      }),
    };
    vi.stubGlobal("EventSource", CrossTabEventSource);
    vi.stubGlobal("BroadcastChannel", SharedBroadcastChannel);
    vi.stubGlobal("navigator", { locks });

    vi.resetModules();
    const firstTab = await import("./federationEventSource");
    const unsubscribeFirst = firstTab.subscribeFederationEvent({
      event: "federation.executors_changed",
      listener: vi.fn(),
    });
    await vi.waitFor(() => expect(instances).toHaveLength(1));
    instances[0]!.emit("federation.catalog_changed", '{"revision":11,"orderRevision":5}');

    vi.resetModules();
    const secondTab = await import("./federationEventSource");
    const secondCatalog = vi.fn();
    const unsubscribeSecond = secondTab.subscribeFederationEvent({
      event: "federation.catalog_changed",
      listener: secondCatalog,
    });
    await vi.waitFor(() => expect(secondCatalog).toHaveBeenCalledOnce());
    expect(secondCatalog.mock.calls[0]![0].data).toContain('"revision":11');
    expect(instances).toHaveLength(1);

    unsubscribeFirst();
    await vi.waitFor(() => expect(instances).toHaveLength(2), { timeout: 2_500 });
    expect(instances[0]!.close).toHaveBeenCalledOnce();
    unsubscribeSecond();
    await vi.waitFor(() => expect(instances[1]!.close).toHaveBeenCalledOnce());
  });
});
