type EventSourceLike = {
  addEventListener: (type: string, listener: (event: MessageEvent<string>) => void) => void;
  close: () => void;
};

export type FederationEventSourceCtor = new (url: string) => EventSourceLike;

const FEDERATION_EVENT_TYPES = [
  "federation.catalog_changed",
  "federation.executors_changed",
  "frontend.updated",
] as const;
type FederationEventType = typeof FEDERATION_EVENT_TYPES[number];
type FederationBusMessage =
  | { kind: "event"; event: FederationEventType; data: string }
  | { kind: "hello" }
  | { kind: "released" };

type SharedSource = {
  refs: number;
  source: EventSourceLike;
  latest: Map<string, string>;
  listeners: Map<string, Set<(event: MessageEvent<string>) => void>>;
};
const localSources = new WeakMap<FederationEventSourceCtor, Map<string, SharedSource>>();
const crossTabSources = new Map<string, CrossTabFederationSource>();

export function subscribeFederationEvent({
  EventSourceCtor = globalThis.EventSource as FederationEventSourceCtor | undefined,
  baseUrl,
  event,
  listener,
}: {
  EventSourceCtor?: FederationEventSourceCtor;
  baseUrl?: string;
  event: string;
  listener: (event: MessageEvent<string>) => void;
}): () => void {
  if (!EventSourceCtor) return () => undefined;
  const route = "/v1/federation/browser-events";
  const url = baseUrl ? new URL(route, baseUrl).toString() : route;
  if (supportsCrossTabSharing(EventSourceCtor)) {
    let source = crossTabSources.get(url);
    if (!source) {
      source = new CrossTabFederationSource(url, EventSourceCtor, () => crossTabSources.delete(url));
      crossTabSources.set(url, source);
    }
    return source.subscribe(event, listener);
  }
  return subscribeLocal(EventSourceCtor, url, event, listener);
}

function supportsCrossTabSharing(EventSourceCtor: FederationEventSourceCtor) {
  return EventSourceCtor === globalThis.EventSource
    && typeof globalThis.BroadcastChannel === "function"
    && typeof navigator !== "undefined"
    && typeof navigator.locks?.request === "function";
}

function subscribeLocal(
  EventSourceCtor: FederationEventSourceCtor,
  url: string,
  event: string,
  listener: (event: MessageEvent<string>) => void,
) {
  let byUrl = localSources.get(EventSourceCtor);
  if (!byUrl) {
    byUrl = new Map();
    localSources.set(EventSourceCtor, byUrl);
  }
  let shared = byUrl.get(url);
  if (!shared) {
    const source = new EventSourceCtor(url);
    shared = { refs: 0, source, latest: new Map(), listeners: new Map() };
    const created = shared;
    for (const eventType of FEDERATION_EVENT_TYPES) {
      source.addEventListener(eventType, (message) => {
        created.latest.set(eventType, message.data);
        for (const subscriber of created.listeners.get(eventType) ?? []) subscriber(message);
      });
    }
    byUrl.set(url, shared);
  }
  shared.refs += 1;
  let active = true;
  const listeners = shared.listeners.get(event) ?? new Set();
  listeners.add(listener);
  shared.listeners.set(event, listeners);
  const latest = shared.latest.get(event);
  if (latest !== undefined) queueMicrotask(() => {
    if (active) listener(new MessageEvent<string>("message", { data: latest }));
  });
  return () => {
    if (!active) return;
    active = false;
    listeners.delete(listener);
    if (listeners.size === 0) shared!.listeners.delete(event);
    shared!.refs -= 1;
    if (shared!.refs > 0) return;
    shared!.source.close();
    byUrl!.delete(url);
    if (byUrl!.size === 0) localSources.delete(EventSourceCtor);
  };
}

class CrossTabFederationSource {
  private readonly channel: BroadcastChannel;
  private readonly latest = new Map<FederationEventType, string>();
  private readonly listeners = new Map<string, Set<(event: MessageEvent<string>) => void>>();
  private acquiring = false;
  private leader = false;
  private refs = 0;
  private releaseLeader: (() => void) | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private readonly url: string,
    private readonly EventSourceCtor: FederationEventSourceCtor,
    private readonly onStopped: () => void,
  ) {
    const identity = new URL(url, globalThis.location?.origin ?? "http://kodex.invalid").toString();
    this.channel = new BroadcastChannel(`kodex-federation-events:${identity}`);
    this.channel.addEventListener("message", (message: MessageEvent<FederationBusMessage>) => {
      if (message.data.kind === "event") {
        this.latest.set(message.data.event, message.data.data);
        this.dispatch(message.data.event, message.data.data);
      } else if (message.data.kind === "hello" && this.leader) {
        for (const [event, data] of this.latest) {
          this.channel.postMessage({ kind: "event", event, data } satisfies FederationBusMessage);
        }
      } else if (message.data.kind === "released") {
        this.scheduleLeaderAttempt(0);
      }
    });
    this.channel.postMessage({ kind: "hello" } satisfies FederationBusMessage);
    this.scheduleLeaderAttempt(0);
  }

  subscribe(event: string, listener: (event: MessageEvent<string>) => void) {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    this.refs += 1;
    let active = true;
    const latest = this.latest.get(event as FederationEventType);
    if (latest !== undefined) queueMicrotask(() => {
      if (active) listener(new MessageEvent<string>("message", { data: latest }));
    });
    return () => {
      if (!active) return;
      active = false;
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(event);
      this.refs -= 1;
      if (this.refs === 0) this.stop();
    };
  }

  private dispatch(event: string, data: string) {
    const message = new MessageEvent<string>("message", { data });
    for (const listener of this.listeners.get(event) ?? []) listener(message);
  }

  private scheduleLeaderAttempt(delay: number) {
    if (this.stopped || this.leader || this.acquiring || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      this.attemptLeadership();
    }, delay);
  }

  private attemptLeadership() {
    if (this.stopped || this.leader || this.acquiring) return;
    this.acquiring = true;
    const identity = new URL(this.url, globalThis.location?.origin ?? "http://kodex.invalid").toString();
    void navigator.locks.request(
      `kodex-federation-events:${identity}`,
      { ifAvailable: true },
      async (lock) => {
        if (!lock || this.stopped) return;
        this.leader = true;
        const source = new this.EventSourceCtor(this.url);
        for (const event of FEDERATION_EVENT_TYPES) {
          source.addEventListener(event, (message) => {
            this.latest.set(event, message.data);
            this.dispatch(event, message.data);
            this.channel.postMessage({ kind: "event", event, data: message.data } satisfies FederationBusMessage);
          });
        }
        await new Promise<void>((resolve) => { this.releaseLeader = resolve; });
        source.close();
        this.releaseLeader = null;
        this.leader = false;
      },
    ).finally(() => {
      this.acquiring = false;
      this.scheduleLeaderAttempt(1_000);
    });
  }

  private stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    if (this.leader) this.channel.postMessage({ kind: "released" } satisfies FederationBusMessage);
    this.releaseLeader?.();
    this.channel.close();
    this.onStopped();
  }
}
