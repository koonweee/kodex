import { describe, expect, it } from "vitest";

import { composerSettingsFromThread, composerThreadSettingsPatch, composerTurnOptions, createThreadOptions } from "./settings";

describe("composerSettingsFromThread", () => {
  it("uses activePermissionProfile without deriving from legacy policy or sandbox fields", () => {
    expect(
      composerSettingsFromThread({
        activePermissionProfile: { id: "read-only", extends: null },
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
      permissionProfileId: "read-only",
    });
  });

  it("keeps raw activePermissionProfile only when the typed field is absent", () => {
    expect(
      composerSettingsFromThread({
        model: null,
        reasoningEffort: null,
        rawPayload: {
          activePermissionProfile: { id: ":workspace" },
          model: "gpt-5.4-mini",
          reasoningEffort: "medium",
        },
        serviceTier: null,
      }),
    ).toMatchObject({
      model: "gpt-5.4-mini",
      effort: "medium",
      permissionProfileId: ":workspace",
    });
  });

  it("treats typed null activePermissionProfile as an authoritative clear", () => {
    expect(
      composerSettingsFromThread({
        activePermissionProfile: null,
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

describe("native permission profile option builders", () => {
  it("emits only permissions profile ids for thread creation, turns, and settings patches", () => {
    const settings = { fast: false, permissionProfileId: "auto-review" };

    expect(createThreadOptions(settings)).toEqual({ permissions: "auto-review" });
    expect(composerTurnOptions(settings)).toEqual({ permissions: "auto-review" });
    expect(composerThreadSettingsPatch({ fast: false }, settings)).toEqual({ permissions: "auto-review" });
  });
});
