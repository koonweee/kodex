import type { QueryClient } from "@tanstack/react-query";

import type { EventEnvelope } from "./client";
import { queryKeys } from "./queryKeys";

export async function refreshNativeConfig(queryClient: QueryClient) {
  const keys = [queryKeys.composerSettingsRoot, queryKeys.permissionProfilesRoot, queryKeys.mcpConfiguredServers, queryKeys.mcpServers];
  await Promise.all(keys.map((queryKey) => queryClient.cancelQueries({ queryKey })));
  await Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
}

export async function applyNativeConfigEvent(queryClient: QueryClient, event: EventEnvelope) {
  if (event.kind === "config.changed") {
    await refreshNativeConfig(queryClient);
  } else if (event.kind === "mcp.server_status_updated" || event.kind === "mcp.oauth_login_completed") {
    await queryClient.cancelQueries({ queryKey: queryKeys.mcpServers });
    await queryClient.invalidateQueries({ queryKey: queryKeys.mcpServers });
  }
}
