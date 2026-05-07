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
});

function skill(name: string): SkillMetadata {
  return {
    description: `${name} description`,
    enabled: true,
    interface: null,
    name,
    path: `/skills/${name}/SKILL.md`,
    scope: "user",
  };
}
