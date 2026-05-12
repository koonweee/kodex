import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import type { EventEnvelope } from "./client";
import { applyMcpLifecycleEvent } from "./mcpCache";
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

describe("MCP cache events", () => {
  it("invalidates MCP server inventory for lifecycle events", () => {
    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();

    applyMcpLifecycleEvent(queryClient, event("mcp.config_changed"));
    applyMcpLifecycleEvent(queryClient, event("mcp.server_status_updated"));
    applyMcpLifecycleEvent(queryClient, event("mcp.oauth_login_completed"));

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.mcpServers });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.mcpConfiguredServers });
    expect(invalidateSpy).toHaveBeenCalledTimes(6);
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

    applyMcpLifecycleEvent(observingClient, event("mcp.config_changed"));

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

  it("ignores unrelated events", () => {
    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();

    applyMcpLifecycleEvent(queryClient, event("skills.changed"));

    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});
