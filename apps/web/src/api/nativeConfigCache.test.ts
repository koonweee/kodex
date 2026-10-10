import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import type { EventEnvelope } from "./client";
import { applyNativeConfigEvent } from "./nativeConfigCache";
import { queryKeys } from "./queryKeys";

function event(kind: string): EventEnvelope {
  const codexMethod =
    kind === "mcp.oauth_login_completed"
      ? "mcpServer/oauthLogin/completed"
      : kind === "mcp.server_status_updated"
        ? "mcpServer/startupStatus/updated"
        : null;
  return {
    codexMethod,
    id: `event-${kind}`,
    itemId: null,
    kind,
    payload: {},
    projectId: null,
    receivedAt: "2026-05-11T00:00:00Z",
    seq: 1,
    threadId: null,
    turnId: null,
  };
}

describe("native configuration cache events", () => {
  it("cancels both clients' earlier inventory reads before a native change refill", async () => {
    let releaseOld: (value: unknown) => void = () => undefined;
    const oldReply = new Promise((resolve) => { releaseOld = resolve; });
    const clients = [new QueryClient(), new QueryClient()];
    const signals: AbortSignal[] = [];
    const cleanups = clients.map((client) => {
      let reads = 0;
      const observer = new QueryObserver(client, {
        queryKey: queryKeys.mcpConfiguredServers,
        queryFn: ({ signal }) => {
          signals.push(signal);
          reads += 1;
          return reads === 1 ? oldReply : Promise.resolve({ servers: [{ name: "native-current" }] });
        },
      });
      return observer.subscribe(() => {});
    });
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    const firstSignals = [...signals];
    clients.forEach((client) => applyNativeConfigEvent(client, event("config.changed")));
    await vi.waitFor(() => expect(firstSignals.every((signal) => signal.aborted)).toBe(true));
    await vi.waitFor(() => clients.forEach((client) => expect(client.getQueryData(queryKeys.mcpConfiguredServers)).toEqual({ servers: [{ name: "native-current" }] })));
    releaseOld({ servers: [{ name: "stale-server" }] });
    await oldReply;
    clients.forEach((client) => expect(client.getQueryData(queryKeys.mcpConfiguredServers)).toEqual({ servers: [{ name: "native-current" }] }));
    cleanups.forEach((cleanup) => cleanup());
    clients.forEach((client) => client.clear());
  });

  it("lets another active client converge by refetching inventory after MCP config events", async () => {
    const actingClient = new QueryClient();
    const observingClient = new QueryClient();
    const actingFetch = vi.fn().mockResolvedValue({ servers: [{ name: "before-action" }] });
    const observingFetch = vi.fn().mockResolvedValue({ servers: [{ name: "before-event" }] });
    const observingConfigFetch = vi.fn().mockResolvedValue({ servers: [{ name: "before-config" }] });
    const actingObserver = new QueryObserver(actingClient, {
      queryFn: actingFetch,
      queryKey: queryKeys.mcpServers,
    });
    const observingObserver = new QueryObserver(observingClient, {
      queryFn: observingFetch,
      queryKey: queryKeys.mcpServers,
    });
    const observingConfigObserver = new QueryObserver(observingClient, {
      queryFn: observingConfigFetch,
      queryKey: queryKeys.mcpConfiguredServers,
    });
    const unsubscribeActing = actingObserver.subscribe(() => {});
    const unsubscribeObserving = observingObserver.subscribe(() => {});
    const unsubscribeObservingConfig = observingConfigObserver.subscribe(() => {});

    await vi.waitFor(() => expect(actingFetch).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(observingFetch).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(observingConfigFetch).toHaveBeenCalledTimes(1));

    observingFetch.mockResolvedValue({ servers: [{ name: "after-event" }] });
    observingConfigFetch.mockResolvedValue({ servers: [{ name: "after-config" }] });

    applyNativeConfigEvent(observingClient, event("config.changed"));

    await vi.waitFor(() =>
      expect(observingClient.getQueryData(queryKeys.mcpServers)).toEqual({
        servers: [{ name: "after-event" }],
      }),
    );
    await vi.waitFor(() =>
      expect(observingClient.getQueryData(queryKeys.mcpConfiguredServers)).toEqual({
        servers: [{ name: "after-config" }],
      }),
    );
    expect(actingFetch).toHaveBeenCalledTimes(1);
    expect(observingFetch).toHaveBeenCalledTimes(2);
    expect(observingConfigFetch).toHaveBeenCalledTimes(2);

    unsubscribeActing();
    unsubscribeObserving();
    unsubscribeObservingConfig();
    actingClient.clear();
    observingClient.clear();
  });

  it("refetches new-chat defaults for every active client after a native config change", async () => {
    const clients = [new QueryClient(), new QueryClient()];
    let current = { model: "before-model", effort: "low" };
    const fetches = clients.map(() => vi.fn(() => Promise.resolve(current)));
    const cleanups = clients.map((client, index) => {
      const observer = new QueryObserver(client, {
        queryFn: fetches[index],
        queryKey: queryKeys.composerSettings(null),
      });
      return observer.subscribe(() => {});
    });

    await vi.waitFor(() => fetches.forEach((fetch) => expect(fetch).toHaveBeenCalledTimes(1)));
    current = { model: "after-model", effort: "high" };
    await Promise.all(clients.map((client) => applyNativeConfigEvent(client, event("config.changed"))));

    clients.forEach((client) => {
      expect(client.getQueryData(queryKeys.composerSettings(null))).toEqual(current);
    });
    fetches.forEach((fetch) => expect(fetch).toHaveBeenCalledTimes(2));

    cleanups.forEach((cleanup) => cleanup());
    clients.forEach((client) => client.clear());
  });

  it("ignores unrelated events", () => {
    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();

    applyNativeConfigEvent(queryClient, event("skills.changed"));

    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});
