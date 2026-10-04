import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { SkillMetadata } from "../api/client";
import { useComposerDraftState, type ComposerDraftStore } from "./useComposerDraftState";

const skill: SkillMetadata = {
  description: "Review the code",
  enabled: true,
  interface: { displayName: "Review Fix", brandColor: "#23a55a" },
  name: "review-fix",
  path: "/skills/review-fix/SKILL.md",
  scope: "user",
};

function selectedDraft() {
  const store: ComposerDraftStore = new Map();
  const hook = renderHook(({ draftKey, resetToken }) => useComposerDraftState(resetToken, draftKey, store), {
    initialProps: { draftKey: "pane:one", resetToken: 0 },
  });
  act(() => {
    hook.result.current.updateComposerText("  请 $rev", "  请 $rev".length);
    hook.result.current.selectSkill(skill);
  });
  return { ...hook, store };
}

describe("captured composer submissions", () => {
  it("restores exactly the selected draft and its display metadata, then persists it under that pane", () => {
    const { result, rerender } = selectedDraft();
    const text = result.current.composerText;
    const mentions = result.current.currentTimelineSkillMentions();
    const submission = result.current.captureSubmission();
    act(() => submission.clearText());
    expect(result.current.currentSkillInputs()).toEqual([]);
    act(() => submission.restoreDraft());
    expect(result.current.composerText).toBe(text);
    expect(result.current.currentTimelineSkillMentions()).toEqual(mentions);
    expect(result.current.currentSkillInputs()).toEqual([{ type: "skill", name: skill.name, path: skill.path }]);
    rerender({ draftKey: "pane:two", resetToken: 0 });
    expect(result.current.composerText).toBe("");
    rerender({ draftKey: "pane:one", resetToken: 0 });
    expect(result.current.currentTimelineSkillMentions()).toEqual(mentions);
  });

  it("does not replace a newer explicit binding even when its visible mention has the same text", () => {
    const { result } = selectedDraft();
    const submission = result.current.captureSubmission();
    act(() => submission.clearText());
    act(() => {
      result.current.updateComposerText("  请 $rev", "  请 $rev".length);
      result.current.selectSkill({ ...skill, path: "/another-catalog/review-fix/SKILL.md" });
    });
    act(() => submission.restoreDraft());
    expect(result.current.composerText).toBe("  请 $review-fix ");
    expect(result.current.currentSkillInputs()).toEqual([{ type: "skill", name: skill.name, path: "/another-catalog/review-fix/SKILL.md" }]);
  });

  it("does not clear newer text when asynchronous creation finishes after the draft changed", () => {
    const { result } = selectedDraft();
    const submission = result.current.captureSubmission();
    act(() => result.current.updateComposerText("New unsent draft", null));
    act(() => { submission.clearText(); submission.restoreDraft(); });
    expect(result.current.composerText).toBe("New unsent draft");
    expect(result.current.currentSkillInputs()).toEqual([]);
  });

  it("does not clear or restore another pane, including after switching away and back", () => {
    const { result, rerender } = selectedDraft();
    const submission = result.current.captureSubmission();
    act(() => submission.clearText());
    rerender({ draftKey: "pane:two", resetToken: 0 });
    act(() => {
      result.current.updateComposerText("$rev", 4);
      result.current.selectSkill({ ...skill, path: "/pane-two/review-fix/SKILL.md" });
      submission.clearText();
      submission.restoreDraft();
    });
    expect(result.current.currentSkillInputs()).toEqual([{ type: "skill", name: skill.name, path: "/pane-two/review-fix/SKILL.md" }]);
    rerender({ draftKey: "pane:one", resetToken: 0 });
    act(() => submission.restoreDraft());
    expect(result.current.composerText).toBe("");
    expect(result.current.currentSkillInputs()).toEqual([]);
  });

  it("does not revive a cleared submission after reset or unmount", () => {
    const { result, rerender, unmount, store } = selectedDraft();
    const submission = result.current.captureSubmission();
    act(() => submission.clearText());
    rerender({ draftKey: "pane:one", resetToken: 1 });
    act(() => submission.restoreDraft());
    expect(result.current.composerText).toBe("");
    act(() => {
      result.current.updateComposerText("$rev", 4);
      result.current.selectSkill(skill);
    });
    const pendingBeforeUnmount = result.current.captureSubmission();
    act(() => pendingBeforeUnmount.clearText());
    unmount();
    pendingBeforeUnmount.restoreDraft();
    expect(store.size).toBe(0);
  });
});
