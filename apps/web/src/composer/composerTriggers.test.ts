import { describe, expect, it } from "vitest";

import { activeSlashCommandToken, replaceComposerTriggerToken } from "./composerTriggers";

describe("composer trigger helpers", () => {
  it("detects slash command tokens at the beginning of composer text", () => {
    expect(activeSlashCommandToken("/compact", "/co".length)).toEqual({
      end: "/compact".length,
      query: "co",
      start: 0,
      trigger: "/",
    });
    expect(activeSlashCommandToken("  /compact", "  /comp".length)).toEqual({
      end: "  /compact".length,
      query: "comp",
      start: 2,
      trigger: "/",
    });
  });

  it("ignores slash text after ordinary prompt content", () => {
    expect(activeSlashCommandToken("Please run /compact", "Please run /compact".length)).toBeNull();
  });

  it("replaces trigger tokens with a trailing space when needed", () => {
    expect(replaceComposerTriggerToken("/co", { start: 0, end: 3 }, "/compact")).toEqual({
      cursor: "/compact ".length,
      text: "/compact ",
    });
    expect(replaceComposerTriggerToken("/co now", { start: 0, end: 3 }, "/compact")).toEqual({
      cursor: "/compact ".length,
      text: "/compact now",
    });
  });
});
