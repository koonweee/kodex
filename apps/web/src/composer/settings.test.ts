import { describe, expect, it } from "vitest";

import { composerSettingsFromThread, composerThreadSettingsPatch, composerTurnOptions, createThreadOptions } from "./settings";

describe("composerSettingsFromThread", () => {
  it("uses model, reasoning, and speed without deriving from legacy policy or sandbox fields", () => {
    expect(
      composerSettingsFromThread({
        model: "gpt-5.5",
        rawPayload: {
          approvalPolicy: "never",
          approvalsReviewer: "auto_review",
          sandbox: { type: "dangerFullAccess" },
        },
        reasoningEffort: "high",
        serviceTier: "fast",
      }),
    ).toEqual({
      fast: true,
      model: "gpt-5.5",
      effort: "high",
      serviceTier: "fast",
    });
  });

  it("keeps raw model fields when typed fields are absent", () => {
    expect(
      composerSettingsFromThread({
        model: null,
        reasoningEffort: null,
        rawPayload: {
          model: "gpt-5.4-mini",
          reasoningEffort: "medium",
        },
        serviceTier: null,
      }),
    ).toMatchObject({
      model: "gpt-5.4-mini",
      effort: "medium",
    });
  });

  it("does not treat permission profile metadata as composer settings", () => {
    expect(
      composerSettingsFromThread({
        model: null,
        reasoningEffort: null,
        rawPayload: {
          activePermissionProfile: { id: "stale-profile" },
        },
        serviceTier: null,
      }),
    ).toBeNull();
  });
});

describe("composer option builders", () => {
  it("omits execution permission overrides so app-server defaults apply", () => {
    const settings = { fast: false };

    // Execution defaults are app-server config, so same-user tabs converge by
    // omitting browser-local permission state from future thread and turn sends.
    expect(createThreadOptions(settings)).toEqual({});
    expect(composerTurnOptions(settings)).toEqual({});
    expect(composerThreadSettingsPatch({ fast: false }, settings)).toEqual({});
  });

  it("preserves explicit fast clears for next create and turn payloads", () => {
    const settings = { fast: false, serviceTier: null };

    expect(createThreadOptions(settings)).toEqual({ serviceTier: null });
    expect(composerTurnOptions(settings)).toEqual({ serviceTier: null });
  });
});
