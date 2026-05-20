import { describe, expect, it } from "vitest";

import { composerSettingsFromThread } from "./settings";

describe("composerSettingsFromThread", () => {
  it("uses typed thread settings without requiring raw payload fields", () => {
    expect(
      composerSettingsFromThread({
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        model: "gpt-5.5",
        rawPayload: {},
        reasoningEffort: "high",
        sandbox: { mode: "workspace-write" },
        serviceTier: "fast",
      }),
    ).toEqual({
      fast: true,
      model: "gpt-5.5",
      effort: "high",
      permissionPreset: "autoReview",
    });
  });

  it("keeps raw payload as a compatibility fallback for older thread summaries", () => {
    expect(
      composerSettingsFromThread({
        approvalPolicy: null,
        approvalsReviewer: null,
        model: null,
        reasoningEffort: null,
        rawPayload: {
          model: "gpt-5.4-mini",
          reasoningEffort: "medium",
        },
        sandbox: null,
        serviceTier: null,
      }),
    ).toMatchObject({
      model: "gpt-5.4-mini",
      effort: "medium",
    });
  });
});
