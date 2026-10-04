import type { QueryClient } from "@tanstack/react-query";
import type { EventEnvelope } from "../api/client";
import { refreshProjectState } from "../projects/cache";

export const PINNED_SECTION_ID = "01984de2-8f74-7c91-a3b2-5c5e937cf318";

export function applyThreadSectionsEvent(queryClient: QueryClient, event: EventEnvelope) {
  if (event.kind === "thread.sections_updated") void refreshProjectState(queryClient);
}
