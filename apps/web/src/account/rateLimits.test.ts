import { describe, expect, it } from "vitest";

import type { EventEnvelope, RateLimitsResponse } from "../api/client";
import {
  formatUsageLimitLines,
  usageLimitSnapshotFromEvent,
  usageLimitSnapshotFromResponse,
} from "./rateLimits";

describe("rate limit usage formatting", () => {
  it("formats primary and secondary windows in the compact menu shape", () => {
    const primaryReset = new Date(2026, 4, 4, 21, 14);
    const secondaryReset = new Date(2026, 4, 7, 16, 0);
    const lines = formatUsageLimitLines(
      {
        limitId: "codex",
        primary: { usedPercent: 18, resetsAt: primaryReset.getTime() / 1000, windowDurationMins: 300 },
        secondary: { usedPercent: 36, resetsAt: secondaryReset.getTime() / 1000, windowDurationMins: 10_080 },
      },
      new Date(2026, 4, 4, 20, 0),
    );

    expect(lines).toEqual({
      primary: "5h 82% left - 9:14 PM",
      secondary: "7d 64% left - 4:00 PM (May 07)",
    });
  });

  it("clamps percent left and falls back when reset timestamps are missing", () => {
    expect(
      formatUsageLimitLines({
        primary: { usedPercent: 120, resetsAt: null, windowDurationMins: null },
        secondary: { usedPercent: -5, resetsAt: null, windowDurationMins: null },
      }),
    ).toEqual({
      primary: "5h 0% left",
      secondary: "7d 100% left",
    });
  });

  it("prefers the codex limit from a multi-limit response", () => {
    const response: RateLimitsResponse = {
      rateLimits: null,
      rateLimitsByLimitId: {
        other: { limitId: "other", primary: { usedPercent: 99 } },
        codex: { limitId: "codex", primary: { usedPercent: 12 } },
      },
      rawPayload: {},
    };

    expect(usageLimitSnapshotFromResponse(response)?.limitId).toBe("codex");
  });

  it("extracts account rate-limit update notifications", () => {
    const event: EventEnvelope = {
      id: "event-1",
      seq: 1,
      kind: "account.rate_limits_updated",
      codexMethod: "account/rateLimits/updated",
      itemId: null,
      threadId: null,
      turnId: null,
      projectId: null,
      payload: {
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 42 },
        },
      },
      receivedAt: "2026-05-04T00:00:00Z",
    };

    expect(usageLimitSnapshotFromEvent(event)?.primary?.usedPercent).toBe(42);
  });
});
