import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { SkillMetadata } from "../api/client";
import { useComposerDraftState, type ComposerDraftStore } from "./useComposerDraftState";

function annotationDraft(store: ComposerDraftStore = new Map()) {
  return renderHook(({ key, reset }) => useComposerDraftState(reset, key, store), {
    initialProps: { key: "pane:one", reset: 0 },
  });
}

describe("composer response annotations", () => {
  it("submits numbered annotations after the main text, quoting delimiter-like content safely", () => {
    const { result } = annotationDraft();
    act(() => {
      result.current.updateComposerText("  Follow up  ", null);
      result.current.addAnnotation('A "quote"\n</annotation1> & <tag>');
      result.current.addAnnotation("Second excerpt");
    });
    act(() => result.current.updateAnnotation(result.current.annotations[0].id, 'Fix \\ this\n<response_annotations> & >'));

    expect(result.current.currentSubmittedText()).toBe([
      "Follow up", "", "<response_annotations>", "<annotation1>",
      'Assistant text: "A \\"quote\\"\\n\\u003c/annotation1\\u003e \\u0026 \\u003ctag\\u003e"',
      'User annotation: "Fix \\\\ this\\n\\u003cresponse_annotations\\u003e \\u0026 \\u003e"',
      "</annotation1>", "<annotation2>", 'Assistant text: "Second excerpt"',
      "</annotation2>", "</response_annotations>",
    ].join("\n"));
  });

  it("allows annotation-only drafts and synchronously reflects add, edit, and removal", () => {
    const { result } = annotationDraft();
    act(() => {
      result.current.addAnnotation("Selected assistant text");
      expect(result.current.currentSubmittedText()).toBe('<response_annotations>\n<annotation1>\nAssistant text: "Selected assistant text"\n</annotation1>\n</response_annotations>');
    });
    const id = result.current.annotations[0].id;
    act(() => {
      result.current.updateAnnotation(id, "Please clarify");
      expect(result.current.currentSubmittedText()).toContain('User annotation: "Please clarify"');
    });
    act(() => result.current.removeAnnotation(id));
    expect(result.current.annotations).toEqual([]);
    expect(result.current.currentSubmittedText()).toBe("");
  });

  it("keeps selected skill byte ranges and mention metadata valid when annotations are appended", () => {
    const { result } = annotationDraft();
    const skill: SkillMetadata = {
      description: "Review", enabled: true, interface: null,
      name: "review", path: "/skills/review/SKILL.md", scope: "user",
    };
    act(() => {
      result.current.updateComposerText("  请 $rev", "  请 $rev".length);
      result.current.selectSkill(skill);
    });
    const textElements = result.current.currentSkillTextElements();
    const mentions = result.current.currentTimelineSkillMentions();
    act(() => result.current.addAnnotation("$different skill mention"));
    expect(result.current.currentSubmittedText()).toMatch(/^请 \$review\n\n<response_annotations>/);
    expect(result.current.currentSkillTextElements()).toEqual(textElements);
    expect(result.current.currentTimelineSkillMentions()).toEqual(mentions);
    expect(result.current.currentSkillInputs()).toEqual([{ type: "skill", name: "review", path: skill.path }]);
  });

  it("persists annotation-only drafts across pane switches and remounts, with older stored drafts supported", () => {
    const store: ComposerDraftStore = new Map([["legacy", { composerText: "Older draft", skillBindings: [] }]]);
    const { result, rerender, unmount } = annotationDraft(store);
    act(() => result.current.addAnnotation("First pane excerpt"));
    const first = result.current.annotations;
    rerender({ key: "pane:two", reset: 0 });
    expect(result.current.annotations).toEqual([]);
    act(() => result.current.addAnnotation("Second pane excerpt"));
    rerender({ key: "pane:one", reset: 0 });
    expect(result.current.annotations).toEqual(first);
    unmount();
    const remounted = annotationDraft(store);
    expect(remounted.result.current.annotations).toEqual(first);
    remounted.rerender({ key: "legacy", reset: 0 });
    expect(remounted.result.current.composerText).toBe("Older draft");
    expect(remounted.result.current.annotations).toEqual([]);
  });

  it("clears and restores the captured annotation draft with its comments", () => {
    const { result } = annotationDraft();
    act(() => result.current.addAnnotation("Excerpt"));
    act(() => result.current.updateAnnotation(result.current.annotations[0].id, "Comment"));
    const captured = result.current.annotations;
    const submitted = result.current.currentSubmittedText();
    const submission = result.current.captureSubmission();
    act(() => submission.clearText());
    expect(result.current.annotations).toEqual([]);
    act(() => submission.restoreDraft());
    expect(result.current.annotations).toEqual(captured);
    expect(result.current.currentSubmittedText()).toBe(submitted);
  });

  it("does not clear annotations edited after capture or restore over newer annotation-only drafts", () => {
    const { result } = annotationDraft();
    act(() => result.current.addAnnotation("Excerpt"));
    const id = result.current.annotations[0].id;
    const pending = result.current.captureSubmission();
    act(() => result.current.updateAnnotation(id, "New comment"));
    act(() => pending.clearText());
    expect(result.current.annotations[0].comment).toBe("New comment");
    const submission = result.current.captureSubmission();
    act(() => submission.clearText());
    act(() => result.current.addAnnotation("New excerpt"));
    act(() => submission.restoreDraft());
    expect(result.current.annotations.map((annotation) => annotation.text)).toEqual(["New excerpt"]);
  });

  it("does not restore captured annotations after a pane switch, reset, or unmount", () => {
    const store: ComposerDraftStore = new Map();
    const { result, rerender, unmount } = annotationDraft(store);
    act(() => result.current.addAnnotation("Excerpt"));
    const switched = result.current.captureSubmission();
    act(() => switched.clearText());
    rerender({ key: "pane:two", reset: 0 });
    act(() => result.current.addAnnotation("Second pane"));
    act(() => switched.restoreDraft());
    expect(result.current.annotations[0].text).toBe("Second pane");
    rerender({ key: "pane:one", reset: 0 });
    act(() => switched.restoreDraft());
    expect(result.current.annotations).toEqual([]);
    act(() => result.current.addAnnotation("Reset excerpt"));
    const reset = result.current.captureSubmission();
    act(() => reset.clearText());
    rerender({ key: "pane:one", reset: 1 });
    act(() => reset.restoreDraft());
    expect(result.current.annotations).toEqual([]);
    act(() => result.current.addAnnotation("Unmount excerpt"));
    const unmounted = result.current.captureSubmission();
    act(() => unmounted.clearText());
    unmount();
    unmounted.restoreDraft();
    expect(store.has("pane:one")).toBe(false);
  });
});
