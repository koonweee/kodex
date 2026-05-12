import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import type { EventEnvelope } from "./client";
import { applyMcpLifecycleEvent } from "./mcpCache";
import { queryKeys } from "./queryKeys";

function event(kind: string): EventEnvelope {
  return {
    codexMethod:
      kind === "mcp.oauth_login_completed"
        ? "mcpServer/oauthLogin/completed"
        : "mcpServer/startupStatus/updated",
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

    applyMcpLifecycleEvent(queryClient, event("mcp.server_status_updated"));
    applyMcpLifecycleEvent(queryClient, event("mcp.oauth_login_completed"));

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.mcpServers });
    expect(invalidateSpy).toHaveBeenCalledTimes(2);
  });

  it("lets another active client converge by refetching inventory after lifecycle events", async () => {
    const actingClient = new QueryClient();
    const observingClient = new QueryClient();
    const actingFetch = vi.fn().mockResolvedValue({ servers: [{ name: "before-action" }] });
    const observingFetch = vi
      .fn()
      .mockResolvedValue({ servers: [{ name: "before-event" }] });
    const actingObserver = new QueryObserver(actingClient, {
      queryFn: actingFetch,
      queryKey: queryKeys.mcpServers,
    });
    const observingObserver = new QueryObserver(observingClient, {
      queryFn: observingFetch,
      queryKey: queryKeys.mcpServers,
    });
    const unsubscribeActing = actingObserver.subscribe(() => {});
    const unsubscribeObserving = observingObserver.subscribe(() => {});

    await vi.waitFor(() => expect(actingFetch).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(observingFetch).toHaveBeenCalledTimes(1));

    observingFetch.mockResolvedValue({ servers: [{ name: "after-event" }] });

    applyMcpLifecycleEvent(observingClient, event("mcp.oauth_login_completed"));

    await vi.waitFor(() =>
      expect(observingClient.getQueryData(queryKeys.mcpServers)).toEqual({
        servers: [{ name: "after-event" }],
      }),
    );
    expect(actingFetch).toHaveBeenCalledTimes(1);
    expect(observingFetch).toHaveBeenCalledTimes(2);

    unsubscribeActing();
    unsubscribeObserving();
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
