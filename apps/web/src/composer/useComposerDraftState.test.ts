import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { SkillMetadata } from "../api/client";
import { useComposerDraftState } from "./useComposerDraftState";

describe("useComposerDraftState", () => {
  it("tracks text, selected skills, submission payloads, and reset controls", () => {
    const { result, rerender } = renderHook(
      ({ resetToken }: { resetToken: number }) => useComposerDraftState(resetToken),
      { initialProps: { resetToken: 0 } },
    );

    act(() => {
      result.current.updateComposerText("  Use $rev", "  Use $rev".length);
    });
    expect(result.current.skillToken).toEqual({
      start: "  Use ".length,
      end: "  Use $rev".length,
      query: "rev",
    });

    let cursor: number | null = null;
    act(() => {
      cursor = result.current.selectSkill(skill("review-fix"));
    });

    expect(cursor).toBe("  Use $review-fix ".length);
    expect(result.current.composerText).toBe("  Use $review-fix ");
    expect(result.current.skillToken).toBeNull();
    expect(result.current.currentSkillInputs()).toEqual([
      { type: "skill", name: "review-fix", path: "/skills/review-fix/SKILL.md" },
    ]);
    expect(result.current.currentSkillTextElements()).toEqual([
      {
        byteRange: {
          start: "Use ".length,
          end: "Use $review-fix".length,
        },
        placeholder: "$review-fix",
      },
    ]);
    expect(result.current.currentTimelineSkillMentions()).toEqual([
      {
        start: "Use ".length,
        end: "Use $review-fix".length,
        name: "review-fix",
        path: "/skills/review-fix/SKILL.md",
        scope: "user",
        shortDescription: "review-fix description",
      },
    ]);

    act(() => {
      expect(result.current.deleteBoundSkillBeforeCursor("  Use $review-fix ".length)).toBe("  Use ".length);
    });
    expect(result.current.composerText).toBe("  Use ");
    expect(result.current.currentSkillInputs()).toEqual([]);

    act(() => {
      result.current.restoreText("Restored draft");
    });
    expect(result.current.composerText).toBe("Restored draft");
    expect(result.current.skillToken).toBeNull();

    act(() => {
      result.current.clearText();
    });
    expect(result.current.composerText).toBe("");

    act(() => {
      result.current.updateComposerText("Will reset", "Will reset".length);
    });
    rerender({ resetToken: 1 });
    expect(result.current.composerText).toBe("");
  });

  it("exposes selected skill metadata synchronously for immediate submit", () => {
    const { result } = renderHook(() => useComposerDraftState(0));

    act(() => {
      result.current.updateComposerText("$doc", "$doc".length);
    });

    let mentions = result.current.currentTimelineSkillMentions();
    act(() => {
      result.current.selectSkill(
        skill("documents:documents", {
          brandColor: "#2563EB",
          displayName: "Documents",
          iconSmall: "/skills/documents/assets/file-document.png",
          shortDescription: "Create and edit document files",
        }),
      );
      mentions = result.current.currentTimelineSkillMentions();
    });

    expect(result.current.currentSubmittedText()).toBe("$documents:documents");
    expect(mentions).toEqual([
      {
        start: 0,
        end: "$documents:documents".length,
        name: "documents:documents",
        path: "/skills/documents:documents/SKILL.md",
        displayName: "Documents",
        scope: "user",
        shortDescription: "Create and edit document files",
        brandColor: "#2563EB",
        iconSmallUrl: "http://localhost:3000/v1/skills/icon?path=%2Fskills%2Fdocuments%2Fassets%2Ffile-document.png",
      },
    ]);
  });
});

function skill(
  name: string,
  options: {
    brandColor?: string;
    displayName?: string;
    iconSmall?: string;
    shortDescription?: string;
  } = {},
): SkillMetadata {
  return {
    description: `${name} description`,
    enabled: true,
    interface:
      options.brandColor || options.displayName || options.iconSmall || options.shortDescription
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
