import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Alert } from "@mantine/core";
import type {
  ClipboardEvent as ReactClipboardEvent,
  ChangeEvent as ReactChangeEvent,
  DragEvent as ReactDragEvent,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  RefObject,
} from "react";

import {
  type ComposerSettings,
  type ComposerSettingsChange,
  type ContextUsage,
} from "../ComposerFooterControls";
import type { ModelSummary, TextElement, TimelineSkillMention, UserInput } from "../api/client";
import type { ImageLightboxImage } from "../images/types";
import { usePaneLayout } from "../shared/PaneLayout";
import { ExpandedComposerPanel } from "./ExpandedComposerPanel";
import { filterSlashCommands, replaceSlashCommandToken, slashCommandItems } from "./slashCommands";
import { filterSkillsForQuery } from "./skillMentions";
import type { PendingAttachment } from "./types";
import { NativeQueuePanel } from "../queuedInputs/NativeQueuePanel";
import { useNativeQueue } from "../queuedInputs/useNativeQueue";
import { useComposerDraftState, type ComposerDraftStore } from "./useComposerDraftState";
import { useSkillCatalog } from "./useSkillCatalog";
import { AssistantSelectionAction } from "../timeline/AssistantSelectionAction";
import { useThreadGoal } from "../goals/useThreadGoal";
import { GoalModal } from "../goals/GoalModal";
import type { GoalControls } from "../goals/GoalControls";
import { useGoalCommand } from "../goals/useGoalCommand";
import { isAlternateSubmitShortcut } from "./submissionIntent";

export type ComposerDraftControls = {
  clearText: () => void;
  restoreDraft: () => void;
};

type ComposerProjectOption = {
  id: string;
  name: string;
};

export type ComposerPanelProps = {
  activeSelectedTurnId: string | null;
  attachmentInputRef: RefObject<HTMLInputElement | null>;
  canCompose: boolean;
  composerSettings: ComposerSettings | null;
  composerSettingsDisabled?: boolean;
  composerSettingsError: string | null;
  composerResetToken: number;
  goalThreadId?: string | null;
  queueThreadId?: string | null;
  paneActive?: boolean;
  composerDraftKey?: string;
  composerDraftStore?: ComposerDraftStore;
  onDraftDisposableChange?: (disposable: boolean) => void;
  composerCwd?: string | null;
  composerShellRef?: RefObject<HTMLDivElement | null>;
  contextUsage?: ContextUsage | null;
  currentProjectName?: string | null;
  draftProjectSelector?: {
    onChange: (projectId: string | null) => void;
    projects: ComposerProjectOption[];
    value: string | null;
  };
  isDraftThreadSelected: boolean;
  isDraftComposerTransitioning: boolean;
  isComposerDragActive: boolean;
  isComposerSubmitting: boolean;
  isSelectedTimelineReady: boolean;
  skillsInvalidationGeneration?: number;
  models: ModelSummary[];
  onAttachmentInputChange: (event: ReactChangeEvent<HTMLInputElement>) => void;
  onComposerDragLeave: (event: ReactDragEvent<HTMLElement>) => void;
  onComposerDragOver: (event: ReactDragEvent<HTMLElement>) => void;
  onComposerDrop: (event: ReactDragEvent<HTMLElement>) => void;
  onComposerKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
  onComposerPaste: (event: ReactClipboardEvent<HTMLTextAreaElement>) => void;
  onComposerSettingsChange: (settings: ComposerSettingsChange) => void;
  onImageOpen: (image: ImageLightboxImage) => void;
  onRemovePendingAttachment: (id: string) => void;
  onStopTurn: () => void;
  onSubmitTurn: (
    event: FormEvent,
    draftText: string,
    controls: ComposerDraftControls,
    skillInputs: UserInput[],
    skillTextElements: TextElement[],
    skillMentions: TimelineSkillMention[],
  ) => void;
  pendingAttachments: PendingAttachment[];
  selectedThreadPresent: boolean;
};

export function ComposerPanel({
  activeSelectedTurnId,
  attachmentInputRef,
  canCompose,
  composerSettings,
  composerSettingsDisabled,
  composerSettingsError,
  composerResetToken,
  goalThreadId = null,
  queueThreadId,
  paneActive = true,
  composerDraftKey,
  composerDraftStore,
  onDraftDisposableChange,
  composerCwd,
  composerShellRef,
  contextUsage,
  currentProjectName,
  draftProjectSelector,
  isDraftThreadSelected,
  isDraftComposerTransitioning,
  isComposerDragActive,
  isComposerSubmitting,
  isSelectedTimelineReady,
  skillsInvalidationGeneration = 0,
  models,
  onAttachmentInputChange,
  onComposerDragLeave,
  onComposerDragOver,
  onComposerDrop,
  onComposerKeyDown,
  onComposerPaste,
  onComposerSettingsChange,
  onImageOpen,
  onRemovePendingAttachment,
  onStopTurn,
  onSubmitTurn,
  pendingAttachments,
  selectedThreadPresent,
}: ComposerPanelProps) {
  const nativeQueue = useNativeQueue(queueThreadId ?? null);
  const draftState = useComposerDraftState(composerResetToken, composerDraftKey, composerDraftStore);
  const [annotationTouchOpenRevision, setAnnotationTouchOpenRevision] = useState(0);
  const draftDisposable = draftState.composerText.length === 0 && draftState.annotations.length === 0 &&
    pendingAttachments.length === 0 && !isComposerSubmitting && !isDraftComposerTransitioning;
  useLayoutEffect(() => {
    onDraftDisposableChange?.(draftDisposable);
  }, [draftDisposable, onDraftDisposableChange]);
  const { compact } = usePaneLayout();
  const threadGoal = useThreadGoal(goalThreadId);
  const currentGoalThreadId = useRef(goalThreadId);
  currentGoalThreadId.current = goalThreadId;
  const [goalEditorThreadId, setGoalEditorThreadId] = useState<string | null>(null);
  useEffect(() => { setGoalEditorThreadId(null); }, [goalThreadId]);
  const openGoalEditor = () => { threadGoal.resetError(); setGoalEditorThreadId(goalThreadId); };
  const goalCommand = useGoalCommand({
    threadId: goalThreadId, draftText: draftState.composerText,
    hasExtraInput: pendingAttachments.length > 0 || draftState.annotations.length > 0 || draftState.skillBindings.length > 0,
    canSubmit: canCompose && !isComposerSubmitting && (!selectedThreadPresent || isSelectedTimelineReady),
    updateGoal: threadGoal.update, onOpen: openGoalEditor,
  });
  const goalControls: GoalControls | undefined = goalThreadId ? {
    goal: threadGoal.goal,
    ready: threadGoal.ready,
    pending: threadGoal.pending,
    error: threadGoal.error,
    compact,
    onOpen: openGoalEditor,
    onReload: threadGoal.reload,
    onDelete: () => {
      if (!threadGoal.goal || threadGoal.pending || !threadGoal.ready) return;
      void threadGoal.clear().catch(() => {
        if (currentGoalThreadId.current === goalThreadId) setGoalEditorThreadId(goalThreadId);
      });
    },
    onToggleStatus: () => {
      if (!threadGoal.goal || threadGoal.pending || !threadGoal.ready) return;
      void threadGoal.update({ status: threadGoal.goal.status === "active" ? "paused" : "active" }).catch(() => {
        if (currentGoalThreadId.current === goalThreadId) setGoalEditorThreadId(goalThreadId);
      });
    },
  } : undefined;
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const internalComposerShellRef = useRef<HTMLDivElement | null>(null);
  const isComposerBusy = isComposerSubmitting || goalCommand.pending;
  const isEntryPending = selectedThreadPresent && !isSelectedTimelineReady && !isDraftComposerTransitioning;
  const isComposerDisabled = !canCompose || isComposerBusy;
  const isComposerControlsDisabled = !paneActive || isComposerDisabled || isEntryPending;
  const canSubmitComposer =
    !isComposerControlsDisabled && (Boolean(draftState.composerText.trim()) || draftState.annotations.length > 0 || pendingAttachments.length > 0);
  const shouldShowStopAction = activeSelectedTurnId !== null && !canSubmitComposer && !isComposerSubmitting;
  const skillPopupOpen = !isComposerControlsDisabled && draftState.skillToken !== null;
  const slashPopupOpen = !isComposerControlsDisabled && draftState.slashToken !== null;
  const triggerPopupOpen = skillPopupOpen || slashPopupOpen;
  const skillCatalog = useSkillCatalog({
    cwd: composerCwd,
    enabled: skillPopupOpen,
    invalidationGeneration: skillsInvalidationGeneration,
  });
  const filteredSkills = useMemo(
    () => filterSkillsForQuery(skillCatalog.skills, draftState.skillToken?.query ?? ""),
    [skillCatalog.skills, draftState.skillToken?.query],
  );
  const slashCommands = useMemo(() => {
    const compactDisabledReason = !selectedThreadPresent
      ? "Select a thread before compacting"
      : activeSelectedTurnId !== null
        ? "Wait for the current task to finish"
        : "Compact is unavailable right now";
    return slashCommandItems({
      canCompact: selectedThreadPresent && activeSelectedTurnId === null,
      compactDisabledReason,
      canSetGoal: goalThreadId !== null,
    });
  }, [activeSelectedTurnId, selectedThreadPresent, goalThreadId]);
  const filteredSlashCommands = useMemo(
    () => filterSlashCommands(slashCommands, draftState.slashToken?.query ?? ""),
    [draftState.slashToken?.query, slashCommands],
  );

  useEffect(() => {
    draftState.clampActiveSkillIndex(filteredSkills.length);
  }, [filteredSkills.length]);

  useEffect(() => {
    draftState.clampActiveSlashIndex(filteredSlashCommands.length);
  }, [filteredSlashCommands.length]);

  useEffect(() => {
    if (!triggerPopupOpen) {
      return;
    }

    function handleDocumentPointerDown(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (internalComposerShellRef.current?.contains(target)) {
        return;
      }
      draftState.closeSkillToken();
      draftState.closeSlashToken();
    }

    document.addEventListener("pointerdown", handleDocumentPointerDown);
    return () => document.removeEventListener("pointerdown", handleDocumentPointerDown);
  }, [triggerPopupOpen]);

  function selectSkill(skillIndex = draftState.activeSkillIndex) {
    const cursor = draftState.selectSkill(filteredSkills[skillIndex]);
    if (cursor === null) {
      return;
    }
    window.requestAnimationFrame(() => {
      textareaRef.current?.setSelectionRange(cursor, cursor);
      textareaRef.current?.focus({ preventScroll: true });
    });
  }

  function selectSlashCommand(commandIndex = draftState.activeSlashIndex) {
    const token = draftState.slashToken;
    const command = filteredSlashCommands[commandIndex];
    if (!token || !command || command.disabledReason) {
      return;
    }
    const replacement = replaceSlashCommandToken(draftState.composerText, token, command);
    const cursor = draftState.replaceSlashToken(replacement.text, replacement.cursor);
    window.requestAnimationFrame(() => {
      textareaRef.current?.setSelectionRange(cursor, cursor);
      textareaRef.current?.focus({ preventScroll: true });
    });
  }

  function handleComposerKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    const empty = !draftState.composerText.trim() && draftState.annotations.length === 0 && pendingAttachments.length === 0;
    if (isAlternateSubmitShortcut(event) && empty && !isComposerControlsDisabled && paneActive && nativeQueue.sendNow()) {
      event.preventDefault();
      return;
    }
    onComposerKeyDown(event);
  }

  function handleTextareaKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key === "Backspace" &&
      event.currentTarget.selectionStart === event.currentTarget.selectionEnd
    ) {
      const cursor = draftState.deleteBoundSkillBeforeCursor(event.currentTarget.selectionStart);
      if (cursor !== null) {
        event.preventDefault();
        window.requestAnimationFrame(() => {
          textareaRef.current?.setSelectionRange(cursor, cursor);
        });
        return;
      }
    }

    if (slashPopupOpen) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        draftState.setActiveSlashIndex((current) =>
          filteredSlashCommands.length === 0 ? 0 : (current + 1) % filteredSlashCommands.length,
        );
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        draftState.setActiveSlashIndex((current) =>
          filteredSlashCommands.length === 0 ? 0 : (current - 1 + filteredSlashCommands.length) % filteredSlashCommands.length,
        );
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        if (filteredSlashCommands.length > 0) {
          selectSlashCommand();
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        draftState.closeSlashToken();
        return;
      }
    }

    if (skillPopupOpen) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        draftState.setActiveSkillIndex((current) => (filteredSkills.length === 0 ? 0 : (current + 1) % filteredSkills.length));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        draftState.setActiveSkillIndex((current) =>
          filteredSkills.length === 0 ? 0 : (current - 1 + filteredSkills.length) % filteredSkills.length,
        );
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        if (filteredSkills.length > 0) {
          selectSkill();
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        draftState.closeSkillToken();
        return;
      }
    }
    handleComposerKeyDown(event);
  }

  const setComposerShellNode = useCallback((node: HTMLDivElement | null) => {
    internalComposerShellRef.current = node;
    if (composerShellRef) {
      composerShellRef.current = node;
    }
  }, [composerShellRef]);

  const queuePanel = queueThreadId ? <NativeQueuePanel key={queueThreadId} threadId={queueThreadId} queue={nativeQueue} isActive={paneActive}
    canRestoreText={!draftState.composerText && draftState.annotations.length === 0 && pendingAttachments.length === 0 && !isComposerBusy}
    onRestoreText={(text) => draftState.updateComposerText(text, null)} /> : null;

  const representationProps = {
    goalControls,
    queuePanel,
    queueOnSubmit: Boolean(nativeQueue.query.data?.queuedInputs.length),
    activeSelectedTurnId,
    attachmentInputRef,
    canCompose,
    canSubmitComposer,
    composerCwd,
    composerResetToken,
    composerSettings,
    composerSettingsDisabled,
    composerSettingsError,
    composerShellRef,
    contextUsage,
    currentProjectName,
    draftProjectSelector,
    draftState,
    filteredSkills,
    filteredSlashCommands,
    handleTextareaKeyDown,
    isComposerBusy,
    isComposerControlsDisabled,
    isComposerDisabled,
    isComposerDragActive,
    isComposerSubmitting: isComposerBusy,
    isDraftComposerTransitioning,
    isDraftThreadSelected,
    isEntryPending,
    isSelectedTimelineReady,
    models,
    onAttachmentInputChange,
    onComposerDragLeave,
    onComposerDragOver,
    onComposerDrop,
    onComposerKeyDown: handleComposerKeyDown,
    onComposerPaste,
    onComposerSettingsChange,
    onImageOpen,
    onRemovePendingAttachment,
    onStopTurn,
    onSubmitTurn: (...args: Parameters<ComposerPanelProps["onSubmitTurn"]>) => {
      if (!goalCommand.handleSubmit(args[0], args[2])) onSubmitTurn(...args);
    },
    pendingAttachments,
    selectedThreadPresent,
    selectSkill,
    selectSlashCommand,
    setComposerShellNode,
    shouldShowStopAction,
    skillCatalog,
    skillPopupOpen,
    slashPopupOpen,
    skillsInvalidationGeneration,
    textareaRef,
  };

  return <>
    {goalCommand.error ? <Alert color="red" role="alert">{goalCommand.error}</Alert> : null}
    <AssistantSelectionAction composerShellRef={internalComposerShellRef}
      disabled={isComposerControlsDisabled || !selectedThreadPresent} draftKey={composerDraftKey}
      onAdd={(text, pointerType) => {
        draftState.addAnnotation(text);
        if (pointerType === "touch") setAnnotationTouchOpenRevision((revision) => revision + 1);
      }} />
    <ExpandedComposerPanel {...representationProps} annotationTouchOpenRevision={annotationTouchOpenRevision} />
    {paneActive && goalThreadId && goalEditorThreadId === goalThreadId ? (
      <GoalModal key={goalThreadId} goal={threadGoal.goal} pending={threadGoal.pending} error={threadGoal.error}
        ready={threadGoal.ready} onReload={threadGoal.reload} onClose={() => setGoalEditorThreadId((current) => current === goalThreadId ? null : current)}
        onUpdate={threadGoal.update} onClear={threadGoal.clear} />
    ) : null}
  </>;
}
