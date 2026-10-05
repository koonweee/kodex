import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { SkillMetadata } from "../api/client";
import { createClientRequestId } from "../shared/id";
import { appendResponseAnnotations, type DraftAnnotation } from "./annotations";
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
  annotations?: DraftAnnotation[];
};

export type ComposerDraftStore = Map<string, StoredComposerDraft>;

export function useComposerDraftState(
  resetToken: number,
  draftKey = DEFAULT_COMPOSER_DRAFT_KEY,
  draftStore?: ComposerDraftStore,
) {
  const activeDraftKey = draftKey || DEFAULT_COMPOSER_DRAFT_KEY;
  const localDraftStoreRef = useRef<ComposerDraftStore>(new Map());
  const draftsByKey = draftStore ?? localDraftStoreRef.current;
  const initialDraft = draftsByKey.get(activeDraftKey);
  const [composerText, setComposerText] = useState(initialDraft?.composerText ?? "");
  const [skillBindings, setSkillBindings] = useState<SkillMentionBinding[]>(initialDraft?.skillBindings ?? []);
  const [annotations, setAnnotations] = useState<DraftAnnotation[]>(initialDraft?.annotations ?? []);
  const [skillToken, setSkillToken] = useState<SkillMentionToken | null>(null);
  const [activeSkillIndex, setActiveSkillIndex] = useState(0);
  const [slashToken, setSlashToken] = useState<ComposerTriggerToken<"/"> | null>(null);
  const [activeSlashIndex, setActiveSlashIndex] = useState(0);
  const activeDraftKeyRef = useRef(activeDraftKey);
  const composerTextRef = useRef(composerText);
  const lastResetTokenRef = useRef(resetToken);
  const skillBindingsRef = useRef(skillBindings);
  const annotationsRef = useRef(annotations);
  const skillTokenRef = useRef(skillToken);
  const slashTokenRef = useRef(slashToken);
  const draftEditRef = useRef(0);

  useLayoutEffect(() => () => {
    draftEditRef.current += 1;
  }, []);

  useLayoutEffect(() => {
    if (activeDraftKeyRef.current === activeDraftKey) {
      return;
    }
    draftEditRef.current += 1;
    persistDraft(activeDraftKeyRef.current, composerTextRef.current, skillBindingsRef.current, annotationsRef.current);
    activeDraftKeyRef.current = activeDraftKey;
    restoreDraftForKey(activeDraftKey);
  }, [activeDraftKey]);

  useEffect(() => {
    if (lastResetTokenRef.current === resetToken) {
      return;
    }
    lastResetTokenRef.current = resetToken;
    draftsByKey.delete(activeDraftKeyRef.current);
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
    const bindingsChanged = !skillMentionBindingsEqual(skillBindingsRef.current, nextBindings);
    const skillTokenChanged = !skillMentionTokensEqual(skillTokenRef.current, nextToken);
    const slashTokenChanged = !slashCommandTokensEqual(slashTokenRef.current, nextSlashToken);
    if (
      composerTextRef.current === nextText &&
      !bindingsChanged &&
      !skillTokenChanged &&
      !slashTokenChanged
    ) {
      return;
    }
    if (composerTextRef.current !== nextText || bindingsChanged) {
      draftEditRef.current += 1;
    }
    composerTextRef.current = nextText;
    if (bindingsChanged) {
      skillBindingsRef.current = nextBindings;
    }
    if (skillTokenChanged) {
      skillTokenRef.current = nextToken;
    }
    if (slashTokenChanged) {
      slashTokenRef.current = nextSlashToken;
    }
    persistDraft(activeDraftKeyRef.current, nextText, nextBindings, annotationsRef.current);
    setComposerText(nextText);
    if (bindingsChanged) {
      setSkillBindings(nextBindings);
    }
    if (skillTokenChanged) {
      setSkillToken(nextToken);
    }
    if (slashTokenChanged) {
      setSlashToken(nextSlashToken);
    }
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
    draftEditRef.current += 1;
    composerTextRef.current = replacement.text;
    skillBindingsRef.current = nextBindings;
    skillTokenRef.current = null;
    slashTokenRef.current = null;
    persistDraft(activeDraftKeyRef.current, replacement.text, nextBindings, annotationsRef.current);
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
    draftEditRef.current += 1;
    composerTextRef.current = deletion.text;
    skillBindingsRef.current = deletion.bindings;
    skillTokenRef.current = null;
    slashTokenRef.current = null;
    persistDraft(activeDraftKeyRef.current, deletion.text, deletion.bindings, annotationsRef.current);
    setComposerText(deletion.text);
    setSkillBindings(deletion.bindings);
    setSkillToken(null);
    setSlashToken(null);
    return deletion.cursor;
  }

  function replaceSlashToken(text: string, cursor: number) {
    draftEditRef.current += 1;
    composerTextRef.current = text;
    skillBindingsRef.current = validSkillMentionBindings(text, skillBindingsRef.current);
    skillTokenRef.current = null;
    slashTokenRef.current = null;
    persistDraft(activeDraftKeyRef.current, text, skillBindingsRef.current, annotationsRef.current);
    setComposerText(text);
    setSkillBindings(skillBindingsRef.current);
    setSkillToken(null);
    setSlashToken(null);
    return cursor;
  }

  function clearText() {
    draftEditRef.current += 1;
    composerTextRef.current = "";
    skillBindingsRef.current = [];
    annotationsRef.current = [];
    skillTokenRef.current = null;
    slashTokenRef.current = null;
    draftsByKey.delete(activeDraftKeyRef.current);
    setComposerText("");
    setSkillBindings([]);
    setAnnotations([]);
    setSkillToken(null);
    setSlashToken(null);
  }

  function addAnnotation(text: string) {
    changeAnnotations([...annotationsRef.current, { id: createClientRequestId(), text, comment: "" }]);
  }

  function updateAnnotation(id: string, comment: string) {
    if (!annotationsRef.current.some((annotation) => annotation.id === id && annotation.comment !== comment)) return;
    changeAnnotations(annotationsRef.current.map((annotation) => annotation.id === id ? { ...annotation, comment } : annotation));
  }

  function removeAnnotation(id: string) {
    const next = annotationsRef.current.filter((annotation) => annotation.id !== id);
    if (next.length !== annotationsRef.current.length) changeAnnotations(next);
  }

  function changeAnnotations(next: DraftAnnotation[]) {
    draftEditRef.current += 1;
    annotationsRef.current = next;
    persistDraft(activeDraftKeyRef.current, composerTextRef.current, skillBindingsRef.current, next);
    setAnnotations(next);
  }

  function captureSubmission() {
    // A late reply must not clear or restore a draft edited or switched since submission.
    const key = activeDraftKeyRef.current;
    const edit = draftEditRef.current;
    const text = composerTextRef.current;
    const bindings = [...skillBindingsRef.current];
    const capturedAnnotations = [...annotationsRef.current];
    let clearedEdit: number | null = null;
    return {
      clearText() {
        if (activeDraftKeyRef.current !== key || draftEditRef.current !== edit) return;
        clearText();
        clearedEdit = draftEditRef.current;
      },
      restoreDraft() {
        if (clearedEdit === null || activeDraftKeyRef.current !== key || draftEditRef.current !== clearedEdit) return;
        clearedEdit = null;
        draftEditRef.current += 1;
        persistDraft(key, text, bindings, capturedAnnotations);
        restoreDraftForKey(key);
      },
    };
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
    return appendResponseAnnotations(currentSubmittedSkillBindings().text, annotationsRef.current);
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

  function persistDraft(key: string, text: string, bindings: SkillMentionBinding[], draftAnnotations: DraftAnnotation[]) {
    if (text.length === 0 && bindings.length === 0 && draftAnnotations.length === 0) {
      draftsByKey.delete(key);
      return;
    }
    draftsByKey.set(key, {
      composerText: text,
      skillBindings: [...bindings],
      annotations: [...draftAnnotations],
    });
  }

  function restoreDraftForKey(key: string) {
    const storedDraft = draftsByKey.get(key);
    const nextText = storedDraft?.composerText ?? "";
    const nextBindings = storedDraft?.skillBindings ?? [];
    const nextAnnotations = storedDraft?.annotations ?? [];
    if (
      composerTextRef.current === nextText &&
      skillMentionBindingsEqual(skillBindingsRef.current, nextBindings) &&
      annotationsRef.current === nextAnnotations &&
      skillTokenRef.current === null &&
      slashTokenRef.current === null
    ) {
      return;
    }
    composerTextRef.current = nextText;
    skillBindingsRef.current = nextBindings;
    annotationsRef.current = nextAnnotations;
    skillTokenRef.current = null;
    slashTokenRef.current = null;
    setComposerText(nextText);
    setSkillBindings(nextBindings);
    setAnnotations(nextAnnotations);
    setSkillToken(null);
    setSlashToken(null);
  }

  return {
    addAnnotation,
    annotations,
    activeSlashIndex,
    activeSkillIndex,
    clampActiveSlashIndex,
    clampActiveSkillIndex,
    captureSubmission,
    clearText,
    closeSlashToken,
    closeSkillToken,
    composerText,
    currentSkillInputs,
    currentSkillTextElements,
    currentSubmittedText,
    currentTimelineSkillMentions,
    deleteBoundSkillBeforeCursor,
    removeAnnotation,
    replaceSlashToken,
    selectSkill,
    setActiveSlashIndex,
    setActiveSkillIndex,
    skillBindings,
    slashToken,
    skillToken,
    updateComposerText,
    updateAnnotation,
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
