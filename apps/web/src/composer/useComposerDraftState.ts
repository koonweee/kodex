import { useEffect, useState } from "react";

import type { SkillMetadata } from "../api/client";
import {
  activeSkillMentionToken,
  deleteSkillMentionBeforeCursor,
  replaceSkillMentionToken,
  skillInputsFromBindings,
  skillTextElementsFromBindings,
  timelineSkillMentionsFromBindings,
  trimmedSkillMentionBindings,
  validSkillMentionBindings,
  type SkillMentionBinding,
  type SkillMentionToken,
} from "./skillMentions";

export function useComposerDraftState(resetToken: number) {
  const [composerText, setComposerText] = useState("");
  const [skillBindings, setSkillBindings] = useState<SkillMentionBinding[]>([]);
  const [skillToken, setSkillToken] = useState<SkillMentionToken | null>(null);
  const [activeSkillIndex, setActiveSkillIndex] = useState(0);

  useEffect(() => {
    clearText();
  }, [resetToken]);

  useEffect(() => {
    setActiveSkillIndex(0);
  }, [skillToken?.query]);

  function updateComposerText(nextText: string, cursor: number | null) {
    setComposerText(nextText);
    setSkillBindings((current) => validSkillMentionBindings(nextText, current));
    setSkillToken(cursor === null ? null : activeSkillMentionToken(nextText, cursor));
  }

  function selectSkill(skill: SkillMetadata | undefined): number | null {
    if (!skillToken || !skill) {
      return null;
    }
    const replacement = replaceSkillMentionToken(composerText, skillToken, skill);
    setComposerText(replacement.text);
    setSkillBindings((current) => [
      ...validSkillMentionBindings(replacement.text, current),
      replacement.binding,
    ]);
    setSkillToken(null);
    return replacement.cursor;
  }

  function deleteBoundSkillBeforeCursor(cursor: number): number | null {
    const deletion = deleteSkillMentionBeforeCursor(composerText, skillBindings, cursor);
    if (!deletion) {
      return null;
    }
    setComposerText(deletion.text);
    setSkillBindings(deletion.bindings);
    setSkillToken(null);
    return deletion.cursor;
  }

  function clearText() {
    setComposerText("");
    setSkillBindings([]);
    setSkillToken(null);
  }

  function restoreText(text: string) {
    setComposerText(text);
    setSkillBindings([]);
    setSkillToken(null);
  }

  function closeSkillToken() {
    setSkillToken(null);
  }

  function clampActiveSkillIndex(filteredSkillCount: number) {
    setActiveSkillIndex((current) => Math.min(current, Math.max(filteredSkillCount - 1, 0)));
  }

  function currentSkillInputs() {
    return skillInputsFromBindings(currentSubmittedSkillBindings().bindings);
  }

  function currentSkillTextElements() {
    const submitted = currentSubmittedSkillBindings();
    return skillTextElementsFromBindings(submitted.text, submitted.bindings);
  }

  function currentTimelineSkillMentions() {
    const submitted = currentSubmittedSkillBindings();
    return timelineSkillMentionsFromBindings(submitted.text, submitted.bindings);
  }

  function currentSubmittedSkillBindings() {
    return trimmedSkillMentionBindings(composerText, skillBindings);
  }

  return {
    activeSkillIndex,
    clampActiveSkillIndex,
    clearText,
    closeSkillToken,
    composerText,
    currentSkillInputs,
    currentSkillTextElements,
    currentTimelineSkillMentions,
    deleteBoundSkillBeforeCursor,
    restoreText,
    selectSkill,
    setActiveSkillIndex,
    skillBindings,
    skillToken,
    updateComposerText,
  };
}

export type ComposerDraftState = ReturnType<typeof useComposerDraftState>;
