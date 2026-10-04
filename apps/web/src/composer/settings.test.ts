import { describe, expect, it } from "vitest";

import { composerSettingsFromNative, composerThreadSettingsPatch, createThreadOptions } from "./settings";

describe("native composer settings", () => {
  it("preserves authoritative values even when the model or effort is absent from the model catalog", () => {
    expect(composerSettingsFromNative({
      model: "native-custom", effort: "ultra", serviceTier: "fast", activePermissionProfile: null,
    })).toEqual({ model: "native-custom", effort: "ultra", fast: true, serviceTier: "fast" });
    expect(composerSettingsFromNative({
      model: "native-custom", effort: null, serviceTier: null, activePermissionProfile: null,
    })).toEqual({ model: "native-custom", effort: undefined, fast: false, serviceTier: null });
  });

  it("translates only the explicit picker intent into native fields", () => {
    expect(composerThreadSettingsPatch({ model: "another-model" })).toEqual({ model: "another-model" });
    expect(composerThreadSettingsPatch({ effort: "high" })).toEqual({ effort: "high" });
    expect(composerThreadSettingsPatch({ fast: true, serviceTier: "fast" })).toEqual({ serviceTier: "fast" });
    expect(composerThreadSettingsPatch({ fast: false, serviceTier: null })).toEqual({ serviceTier: null });
  });

  it("retains explicit draft creation choices, including clearing Fast, without permission overrides", () => {
    expect(createThreadOptions({ fast: false })).toEqual({});
    expect(createThreadOptions({ model: "gpt-5.5", effort: "high", fast: false, serviceTier: null }))
      .toEqual({ model: "gpt-5.5", effort: "high", serviceTier: null });
  });
});
