import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EventEnvelope } from "../api/client";
import { handlePwaLiveEvent } from "./liveUpdates";
import { requestPwaUpdateCheck } from "./registerServiceWorker";

vi.mock("./registerServiceWorker", () => ({
  requestPwaUpdateCheck: vi.fn().mockResolvedValue(undefined),
}));

function event(kind: string): EventEnvelope {
  return {
    seq: 1,
    id: "event-1",
    receivedAt: "2026-10-09T00:00:00Z",
    projectId: null,
    threadId: null,
    turnId: null,
    itemId: null,
    kind,
    codexMethod: null,
    payload: {},
  };
}

describe("handlePwaLiveEvent", () => {
  beforeEach(() => vi.clearAllMocks());

  it("checks the service worker for a frontend deployment event", async () => {
    expect(handlePwaLiveEvent(event("frontend.updated"))).toBe(true);
    await vi.waitFor(() => expect(requestPwaUpdateCheck).toHaveBeenCalledTimes(1));
  });

  it("ignores unrelated global events", () => {
    expect(handlePwaLiveEvent(event("project.changed"))).toBe(false);
    expect(requestPwaUpdateCheck).not.toHaveBeenCalled();
  });
});
