import { describe, expect, it } from "vitest";

import type { SkillMetadata } from "../api/client";
import {
  activeSkillMentionToken,
  deleteSkillMentionBeforeCursor,
  filterSkillsForQuery,
  replaceSkillMentionToken,
  skillInputsFromBindings,
  skillTextElementsFromBindings,
  timelineSkillMentionsFromBindings,
  trimmedSkillMentionBindings,
  validSkillMentionBindings,
} from "./skillMentions";

describe("skill mention helpers", () => {
  it("detects active $ tokens and ignores common env vars", () => {
    expect(activeSkillMentionToken("Run $review-fix", "Run $review".length)).toEqual({
      start: 4,
      end: 15,
      query: "review",
    });
    expect(activeSkillMentionToken("echo $PATH", "echo $PATH".length)).toBeNull();
  });

  it("keeps plugin-qualified skill names in the active token", () => {
    expect(activeSkillMentionToken("Run $browser-use:browser", "Run $browser-use:browser".length)).toEqual({
      start: 4,
      end: "Run $browser-use:browser".length,
      query: "browser-use:browser",
    });
  });

  it("replaces a token and keeps only still-valid bindings", () => {
    const token = activeSkillMentionToken("Run $rev now", "Run $rev".length);
    expect(token).not.toBeNull();
    const replacement = replaceSkillMentionToken("Run $rev now", token!, skill("review-fix"));

    expect(replacement.text).toBe("Run $review-fix now");
    expect(replacement.cursor).toBe("Run $review-fix".length);
    expect(validSkillMentionBindings(replacement.text, [replacement.binding])).toEqual([
      replacement.binding,
    ]);
    expect(validSkillMentionBindings("Run $changed now", [replacement.binding])).toEqual([]);
  });

  it("deduplicates structured skill inputs by path", () => {
    expect(
      skillInputsFromBindings([
        { start: 0, end: 11, name: "review-fix", path: "/skills/review/SKILL.md" },
        { start: 20, end: 31, name: "review-fix", path: "/skills/review/SKILL.md" },
      ]),
    ).toEqual([{ type: "skill", name: "review-fix", path: "/skills/review/SKILL.md" }]);
  });

  it("creates text elements with utf-8 byte ranges for selected skill bindings", () => {
    const text = "Use 🚀 $review-fix";
    const binding = {
      start: "Use 🚀 ".length,
      end: "Use 🚀 $review-fix".length,
      name: "review-fix",
      path: "/skills/review/SKILL.md",
    };

    expect(skillTextElementsFromBindings(text, [binding])).toEqual([
      {
        byteRange: {
          start: new TextEncoder().encode("Use 🚀 ").length,
          end: new TextEncoder().encode("Use 🚀 $review-fix").length,
        },
        placeholder: "$review-fix",
      },
    ]);
    expect(timelineSkillMentionsFromBindings(text, [binding])).toEqual([
      {
        start: binding.start,
        end: binding.end,
        name: "review-fix",
        path: "/skills/review/SKILL.md",
      },
    ]);
  });

  it("carries selected skill display metadata into optimistic timeline mentions", () => {
    const text = "Use $review-fix";
    const binding = replaceSkillMentionToken(
      "Use $rev",
      { start: "Use ".length, end: "Use $rev".length, query: "rev" },
      skill("review-fix", {
        brandColor: "#23a55a",
        displayName: "Review Fix",
        iconSmall: "/skills/review-fix/icon.png",
        shortDescription: "Review loop",
      }),
    ).binding;

    expect(timelineSkillMentionsFromBindings(text, [binding])).toEqual([
      {
        start: "Use ".length,
        end: "Use $review-fix".length,
        name: "review-fix",
        path: "/skills/review-fix/SKILL.md",
        displayName: "Review Fix",
        scope: "user",
        shortDescription: "Review loop",
        brandColor: "#23a55a",
        iconSmallUrl: "http://localhost:3000/v1/skills/icon?path=%2Fskills%2Freview-fix%2Ficon.png",
      },
    ]);
  });

  it("keeps app-server skill sidecar inputs limited to name and path", () => {
    const replacement = replaceSkillMentionToken(
      "Use $rev",
      { start: "Use ".length, end: "Use $rev".length, query: "rev" },
      skill("review-fix", { displayName: "Review Fix" }),
    );

    expect(skillInputsFromBindings([replacement.binding])).toEqual([
      { type: "skill", name: "review-fix", path: "/skills/review-fix/SKILL.md" },
    ]);
  });

  it("shifts selected skill bindings to match trimmed submitted text", () => {
    expect(
      trimmedSkillMentionBindings("  Use $review-fix  ", [
        {
          start: "  Use ".length,
          end: "  Use $review-fix".length,
          name: "review-fix",
          path: "/skills/review/SKILL.md",
        },
      ]),
    ).toEqual({
      text: "Use $review-fix",
      bindings: [
        {
          start: "Use ".length,
          end: "Use $review-fix".length,
          name: "review-fix",
          path: "/skills/review/SKILL.md",
        },
      ],
    });
  });

  it("deletes a bound skill mention and shifts later bindings", () => {
    const text = "$review-fix then $imagegen ";
    const bindings = [
      { start: 0, end: "$review-fix".length, name: "review-fix", path: "/skills/review/SKILL.md" },
      {
        start: "$review-fix then ".length,
        end: "$review-fix then $imagegen".length,
        name: "imagegen",
        path: "/skills/imagegen/SKILL.md",
      },
    ];

    expect(deleteSkillMentionBeforeCursor(text, bindings, "$review-fix ".length)).toEqual({
      text: "then $imagegen ",
      cursor: 0,
      bindings: [
        {
          start: "then ".length,
          end: "then $imagegen".length,
          name: "imagegen",
          path: "/skills/imagegen/SKILL.md",
        },
      ],
    });
  });

  it("filters enabled skills by display name, name, and description", () => {
    expect(
      filterSkillsForQuery(
        [
          skill("review-fix", { displayName: "Review Fix" }),
          skill("imagegen", { description: "Generate raster images" }),
          skill("disabled", { enabled: false }),
        ],
        "image",
      ).map((item) => item.name),
    ).toEqual(["imagegen"]);
  });

  it("matches compact skill abbreviations as fuzzy subsequences", () => {
    expect(
      filterSkillsForQuery(
        [
          skill("imagegen", { displayName: "Image Gen" }),
          skill("review-fix", { displayName: "Review Fix" }),
        ],
        "img",
      ).map((item) => item.name),
    ).toEqual(["imagegen"]);
  });
});

function skill(
  name: string,
  options: {
    brandColor?: string;
    description?: string;
    displayName?: string;
    enabled?: boolean;
    iconSmall?: string;
    shortDescription?: string;
  } = {},
): SkillMetadata {
  return {
    description: options.description ?? `${name} description`,
    enabled: options.enabled ?? true,
    interface: options.displayName || options.shortDescription || options.brandColor || options.iconSmall
      ? {
          brandColor: options.brandColor,
          displayName: options.displayName,
          iconSmall: options.iconSmall,
          shortDescription: options.shortDescription,
        }
      : null,
    name,
    path: `/skills/${name}/SKILL.md`,
    scope: "user",
  };
}
