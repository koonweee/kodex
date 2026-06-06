import type { QueryClient } from "@tanstack/react-query";

import type { EventEnvelope, GeneratedUiSession } from "../api/client";
import { queryKeys } from "../api/queryKeys";

const GENERATED_UI_EVENTS = new Set([
  "generated_ui.session_upserted",
  "generated_ui.session_submitted",
  "generated_ui.session_archived",
]);

function isGeneratedUiEvent(event: EventEnvelope): boolean {
  return GENERATED_UI_EVENTS.has(event.kind);
}

export function applyGeneratedUiEvent(queryClient: QueryClient, event: EventEnvelope) {
  const session = generatedUiSessionFromEvent(event);
  if (!session) {
    if (event.kind === "generated_ui.session_archived" && event.threadId) {
      queryClient.setQueryData<GeneratedUiSession | null>(queryKeys.generatedUi(event.threadId), null);
    }
    return;
  }

  queryClient.setQueryData<GeneratedUiSession | null>(
    queryKeys.generatedUi(session.threadId),
    event.kind === "generated_ui.session_archived" ? null : session,
  );
}

function generatedUiSessionFromEvent(event: EventEnvelope): GeneratedUiSession | null {
  if (!isGeneratedUiEvent(event) || typeof event.payload !== "object" || event.payload === null) {
    return null;
  }
  const payload = event.payload as Partial<GeneratedUiSession>;
  return typeof payload.id === "string" && typeof payload.threadId === "string" ? (payload as GeneratedUiSession) : null;
}
