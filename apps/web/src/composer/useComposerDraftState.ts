import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { SkillMetadata } from "../api/client";
import { activeSlashCommandToken } from "./composerTriggers";
import type { ComposerTriggerToken } from "./composerTriggers";
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

const DEFAULT_COMPOSER_DRAFT_KEY = "__default__";

type StoredComposerDraft = {
  composerText: string;
  skillBindings: SkillMentionBinding[];
};

export function useComposerDraftState(resetToken: number, draftKey = DEFAULT_COMPOSER_DRAFT_KEY) {
  const [composerText, setComposerText] = useState("");
  const [skillBindings, setSkillBindings] = useState<SkillMentionBinding[]>([]);
  const [skillToken, setSkillToken] = useState<SkillMentionToken | null>(null);
  const [activeSkillIndex, setActiveSkillIndex] = useState(0);
  const [slashToken, setSlashToken] = useState<ComposerTriggerToken<"/"> | null>(null);
  const [activeSlashIndex, setActiveSlashIndex] = useState(0);
  const activeDraftKey = draftKey || DEFAULT_COMPOSER_DRAFT_KEY;
  const activeDraftKeyRef = useRef(activeDraftKey);
  const composerTextRef = useRef(composerText);
  const draftsByKeyRef = useRef(new Map<string, StoredComposerDraft>());
  const skillBindingsRef = useRef(skillBindings);
  const skillTokenRef = useRef(skillToken);
  const slashTokenRef = useRef(slashToken);

  useLayoutEffect(() => {
    if (activeDraftKeyRef.current === activeDraftKey) {
      return;
    }
    persistDraft(activeDraftKeyRef.current, composerTextRef.current, skillBindingsRef.current);
    activeDraftKeyRef.current = activeDraftKey;
    restoreDraftForKey(activeDraftKey);
  }, [activeDraftKey]);

  useEffect(() => {
    draftsByKeyRef.current.delete(activeDraftKeyRef.current);
    clearText();
  }, [resetToken]);

  useEffect(() => {
    setActiveSkillIndex(0);
  }, [skillToken?.query]);

  useEffect(() => {
    setActiveSlashIndex(0);
  }, [slashToken?.query]);

  function updateComposerText(nextText: string, cursor: number | null) {
    const nextBindings = validSkillMentionBindings(nextText, skillBindingsRef.current);
    const nextToken = cursor === null ? null : activeSkillMentionToken(nextText, cursor);
    const nextSlashToken = cursor === null ? null : activeSlashCommandToken(nextText, cursor);
    if (
      composerTextRef.current === nextText &&
      skillMentionBindingsEqual(skillBindingsRef.current, nextBindings) &&
      skillMentionTokensEqual(skillTokenRef.current, nextToken) &&
      slashCommandTokensEqual(slashTokenRef.current, nextSlashToken)
    ) {
      return;
    }
    composerTextRef.current = nextText;
    skillBindingsRef.current = nextBindings;
    skillTokenRef.current = nextToken;
    slashTokenRef.current = nextSlashToken;
    persistDraft(activeDraftKeyRef.current, nextText, nextBindings);
    setComposerText(nextText);
    setSkillBindings(nextBindings);
    setSkillToken(nextToken);
    setSlashToken(nextSlashToken);
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
    slashTokenRef.current = null;
    persistDraft(activeDraftKeyRef.current, replacement.text, nextBindings);
    setComposerText(replacement.text);
    setSkillBindings(nextBindings);
    setSkillToken(null);
    setSlashToken(null);
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
    slashTokenRef.current = null;
    persistDraft(activeDraftKeyRef.current, deletion.text, deletion.bindings);
    setComposerText(deletion.text);
    setSkillBindings(deletion.bindings);
    setSkillToken(null);
    setSlashToken(null);
    return deletion.cursor;
  }

  function replaceSlashToken(text: string, cursor: number) {
    composerTextRef.current = text;
    skillBindingsRef.current = validSkillMentionBindings(text, skillBindingsRef.current);
    skillTokenRef.current = null;
    slashTokenRef.current = null;
    persistDraft(activeDraftKeyRef.current, text, skillBindingsRef.current);
    setComposerText(text);
    setSkillBindings(skillBindingsRef.current);
    setSkillToken(null);
    setSlashToken(null);
    return cursor;
  }

  function clearText() {
    composerTextRef.current = "";
    skillBindingsRef.current = [];
    skillTokenRef.current = null;
    slashTokenRef.current = null;
    draftsByKeyRef.current.delete(activeDraftKeyRef.current);
    setComposerText("");
    setSkillBindings([]);
    setSkillToken(null);
    setSlashToken(null);
  }

  function restoreText(text: string) {
    composerTextRef.current = text;
    skillBindingsRef.current = [];
    skillTokenRef.current = null;
    slashTokenRef.current = null;
    persistDraft(activeDraftKeyRef.current, text, []);
    setComposerText(text);
    setSkillBindings([]);
    setSkillToken(null);
    setSlashToken(null);
  }

  function closeSkillToken() {
    skillTokenRef.current = null;
    setSkillToken(null);
  }

  function closeSlashToken() {
    slashTokenRef.current = null;
    setSlashToken(null);
  }

  function clampActiveSkillIndex(filteredSkillCount: number) {
    setActiveSkillIndex((current) => Math.min(current, Math.max(filteredSkillCount - 1, 0)));
  }

  function clampActiveSlashIndex(filteredCommandCount: number) {
    setActiveSlashIndex((current) => Math.min(current, Math.max(filteredCommandCount - 1, 0)));
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

  function persistDraft(key: string, text: string, bindings: SkillMentionBinding[]) {
    if (text.length === 0 && bindings.length === 0) {
      draftsByKeyRef.current.delete(key);
      return;
    }
    draftsByKeyRef.current.set(key, {
      composerText: text,
      skillBindings: [...bindings],
    });
  }

  function restoreDraftForKey(key: string) {
    const storedDraft = draftsByKeyRef.current.get(key);
    const nextText = storedDraft?.composerText ?? "";
    const nextBindings = storedDraft?.skillBindings ?? [];
    composerTextRef.current = nextText;
    skillBindingsRef.current = nextBindings;
    skillTokenRef.current = null;
    slashTokenRef.current = null;
    setComposerText(nextText);
    setSkillBindings(nextBindings);
    setSkillToken(null);
    setSlashToken(null);
  }

  return {
    activeSlashIndex,
    activeSkillIndex,
    clampActiveSlashIndex,
    clampActiveSkillIndex,
    clearText,
    closeSlashToken,
    closeSkillToken,
    composerText,
    currentSkillInputs,
    currentSkillTextElements,
    currentSubmittedText,
    currentTimelineSkillMentions,
    deleteBoundSkillBeforeCursor,
    restoreText,
    replaceSlashToken,
    selectSkill,
    setActiveSlashIndex,
    setActiveSkillIndex,
    skillBindings,
    slashToken,
    skillToken,
    updateComposerText,
  };
}

export type ComposerDraftState = ReturnType<typeof useComposerDraftState>;

function skillMentionTokensEqual(left: SkillMentionToken | null, right: SkillMentionToken | null) {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return left.start === right.start && left.end === right.end && left.query === right.query;
}

function slashCommandTokensEqual(left: ComposerTriggerToken<"/"> | null, right: ComposerTriggerToken<"/"> | null) {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return left.start === right.start && left.end === right.end && left.query === right.query;
}

function skillMentionBindingsEqual(left: SkillMentionBinding[], right: SkillMentionBinding[]) {
  if (left === right) {
    return true;
  }
  if (left.length !== right.length) {
    return false;
  }
  return left.every((binding, index) => skillMentionBindingEqual(binding, right[index]));
}

function skillMentionBindingEqual(left: SkillMentionBinding, right: SkillMentionBinding) {
  return (
    left.start === right.start &&
    left.end === right.end &&
    left.name === right.name &&
    left.path === right.path &&
    left.displayName === right.displayName &&
    left.scope === right.scope &&
    left.shortDescription === right.shortDescription &&
    left.brandColor === right.brandColor &&
    left.iconSmallUrl === right.iconSmallUrl
  );
}
