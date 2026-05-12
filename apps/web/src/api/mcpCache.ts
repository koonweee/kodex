import type { QueryClient } from "@tanstack/react-query";

import type { EventEnvelope } from "./client";
import { queryKeys } from "./queryKeys";

export function applyMcpLifecycleEvent(queryClient: QueryClient, event: EventEnvelope) {
  if (
    event.kind !== "mcp.config_changed" &&
    event.kind !== "mcp.server_status_updated" &&
    event.kind !== "mcp.oauth_login_completed"
  ) {
    return;
  }
  void queryClient.invalidateQueries({ queryKey: queryKeys.mcpConfiguredServers });
  void queryClient.invalidateQueries({ queryKey: queryKeys.mcpServers });
}
