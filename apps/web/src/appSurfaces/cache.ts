import type { QueryClient } from "@tanstack/react-query";

import type { EventEnvelope } from "../api/client";
import { queryKeys } from "../api/queryKeys";

const APP_SURFACE_EVENTS = new Set([
  "app_surface.session_upserted",
  "app_surface.session_submitted",
  "app_surface.session_archived",
  "app_surface.session_error",
]);

export function applyAppSurfaceEvent(queryClient: QueryClient, event: EventEnvelope) {
  if (!APP_SURFACE_EVENTS.has(event.kind) || !event.threadId) return;
  // Event publication and replay need not reflect the current session order.
  // Read the gateway after retiring any snapshot captured before the event.
  void refreshAppSurfaceSessions(queryClient, event.threadId);
}

export async function refreshAppSurfaceSessions(queryClient: QueryClient, threadId?: string) {
  const queryKey = threadId ? queryKeys.appSurface(threadId) : queryKeys.appSurfaceRoot;
  await queryClient.cancelQueries({ queryKey });
  await queryClient.invalidateQueries({ queryKey });
}
