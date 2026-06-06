import type { QueryClient } from "@tanstack/react-query";

import type { AppSurfaceSession, EventEnvelope } from "../api/client";
import { queryKeys } from "../api/queryKeys";

const APP_SURFACE_EVENTS = new Set([
  "app_surface.session_upserted",
  "app_surface.session_submitted",
  "app_surface.session_archived",
  "app_surface.session_error",
]);

function isAppSurfaceEvent(event: EventEnvelope): boolean {
  return APP_SURFACE_EVENTS.has(event.kind);
}

export function applyAppSurfaceEvent(queryClient: QueryClient, event: EventEnvelope) {
  const session = appSurfaceSessionFromEvent(event);
  if (!session) {
    if (event.kind === "app_surface.session_archived" && event.threadId) {
      queryClient.setQueryData<AppSurfaceSession | null>(queryKeys.appSurface(event.threadId), null);
    }
    return;
  }

  queryClient.setQueryData<AppSurfaceSession | null>(
    queryKeys.appSurface(session.threadId),
    event.kind === "app_surface.session_archived" ? null : session,
  );
}

function appSurfaceSessionFromEvent(event: EventEnvelope): AppSurfaceSession | null {
  if (!isAppSurfaceEvent(event) || typeof event.payload !== "object" || event.payload === null) {
    return null;
  }
  const payload = event.payload as Partial<AppSurfaceSession>;
  return typeof payload.id === "string" && typeof payload.threadId === "string" ? (payload as AppSurfaceSession) : null;
}
