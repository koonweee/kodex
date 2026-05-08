import { useEffect, useRef, useState } from "react";

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
  const composerTextRef = useRef(composerText);
  const skillBindingsRef = useRef(skillBindings);
  const skillTokenRef = useRef(skillToken);

  useEffect(() => {
    clearText();
  }, [resetToken]);

  useEffect(() => {
    setActiveSkillIndex(0);
  }, [skillToken?.query]);

  function updateComposerText(nextText: string, cursor: number | null) {
    const nextBindings = validSkillMentionBindings(nextText, skillBindingsRef.current);
    const nextToken = cursor === null ? null : activeSkillMentionToken(nextText, cursor);
    composerTextRef.current = nextText;
    skillBindingsRef.current = nextBindings;
    skillTokenRef.current = nextToken;
    setComposerText(nextText);
    setSkillBindings(nextBindings);
    setSkillToken(nextToken);
  }

  function selectSkill(skill: SkillMetadata | undefined): number | null {
    const token = skillTokenRef.current;
    if (!token || !skill) {
      return null;
    }
    const replacement = replaceSkillMentionToken(composerTextRef.current, token, skill);
    const nextBindings = [
      ...validSkillMentionBindings(replacement.text, skillBindingsRef.current),
      replacement.binding,
    ];
    composerTextRef.current = replacement.text;
    skillBindingsRef.current = nextBindings;
    skillTokenRef.current = null;
    setComposerText(replacement.text);
    setSkillBindings(nextBindings);
    setSkillToken(null);
    return replacement.cursor;
  }

  function deleteBoundSkillBeforeCursor(cursor: number): number | null {
    const deletion = deleteSkillMentionBeforeCursor(composerTextRef.current, skillBindingsRef.current, cursor);
    if (!deletion) {
      return null;
    }
    composerTextRef.current = deletion.text;
    skillBindingsRef.current = deletion.bindings;
    skillTokenRef.current = null;
    setComposerText(deletion.text);
    setSkillBindings(deletion.bindings);
    setSkillToken(null);
    return deletion.cursor;
  }

  function clearText() {
    composerTextRef.current = "";
    skillBindingsRef.current = [];
    skillTokenRef.current = null;
    setComposerText("");
    setSkillBindings([]);
    setSkillToken(null);
  }

  function restoreText(text: string) {
    composerTextRef.current = text;
    skillBindingsRef.current = [];
    skillTokenRef.current = null;
    setComposerText(text);
    setSkillBindings([]);
    setSkillToken(null);
  }

  function closeSkillToken() {
    skillTokenRef.current = null;
    setSkillToken(null);
  }

  function clampActiveSkillIndex(filteredSkillCount: number) {
    setActiveSkillIndex((current) => Math.min(current, Math.max(filteredSkillCount - 1, 0)));
  }

  function currentSkillInputs() {
    return skillInputsFromBindings(currentSubmittedSkillBindings().bindings);
  }

  function currentSubmittedText() {
    return currentSubmittedSkillBindings().text;
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
    return trimmedSkillMentionBindings(composerTextRef.current, skillBindingsRef.current);
  }

  return {
    activeSkillIndex,
    clampActiveSkillIndex,
    clearText,
    closeSkillToken,
    composerText,
    currentSkillInputs,
    currentSkillTextElements,
    currentSubmittedText,
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
