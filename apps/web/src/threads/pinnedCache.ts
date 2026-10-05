import type { QueryClient } from "@tanstack/react-query";
import type { EventEnvelope } from "../api/client";
import { refreshProjectState } from "../projects/cache";

export function applyThreadPinsEvent(queryClient: QueryClient, event: EventEnvelope) {
  if (event.kind === "thread.pins_updated") void refreshProjectState(queryClient);
}
