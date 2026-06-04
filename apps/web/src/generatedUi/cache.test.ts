import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import type { EventEnvelope, GeneratedUiSession } from "../api/client";
import { queryKeys } from "../api/queryKeys";
import { applyGeneratedUiEvent } from "./cache";

describe("generated UI cache events", () => {
  it("applies upsert, submitted, and archived events to the thread generated UI cache", () => {
    const queryClient = new QueryClient();
    const interactive = generatedUiSession({ revision: 1, status: "interactive", submitAvailable: true });
    const submitted = generatedUiSession({
      revision: 1,
      status: "submitted",
      submitAvailable: false,
      submittedMessage: "Pick mockup A",
      submittedRevision: 1,
    });

    applyGeneratedUiEvent(queryClient, generatedUiEvent("generated_ui.session_upserted", interactive));
    expect(queryClient.getQueryData(queryKeys.generatedUi("thread-1"))).toEqual(interactive);

    applyGeneratedUiEvent(queryClient, generatedUiEvent("generated_ui.session_submitted", submitted));
    expect(queryClient.getQueryData(queryKeys.generatedUi("thread-1"))).toEqual(submitted);

    applyGeneratedUiEvent(queryClient, generatedUiEvent("generated_ui.session_archived", submitted));
    expect(queryClient.getQueryData(queryKeys.generatedUi("thread-1"))).toBeNull();
  });

  it("clears cached state on archived events with only a thread id", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(queryKeys.generatedUi("thread-1"), generatedUiSession());

    applyGeneratedUiEvent(queryClient, {
      ...generatedUiEvent("generated_ui.session_archived", null),
      threadId: "thread-1",
    });

    expect(queryClient.getQueryData(queryKeys.generatedUi("thread-1"))).toBeNull();
  });
});

function generatedUiEvent(kind: string, session: GeneratedUiSession | null): EventEnvelope {
  return {
    codexMethod: null,
    id: `event-${kind}`,
    itemId: null,
    kind,
    payload: session,
    projectId: null,
    receivedAt: "2026-04-30T00:00:00Z",
    seq: 1,
    threadId: session?.threadId ?? null,
    turnId: null,
  };
}

function generatedUiSession(overrides: Partial<GeneratedUiSession> = {}): GeneratedUiSession {
  return {
    archivedAt: null,
    createdAt: "2026-04-30T00:00:00Z",
    documentUrl: "/v1/generated-ui/sessions/session-1/document?revision=1",
    id: "session-1",
    networkPolicy: "self_contained",
    revision: 1,
    status: "interactive",
    submitAvailable: true,
    submittedAt: null,
    submittedMessage: null,
    submittedMetadata: null,
    submittedRevision: null,
    threadId: "thread-1",
    title: "Mockups",
    updatedAt: "2026-04-30T00:00:00Z",
    ...overrides,
  };
}
