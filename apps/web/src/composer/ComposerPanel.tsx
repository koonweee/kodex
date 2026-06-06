import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  type ContextUsage,
} from "../ComposerFooterControls";
import type { ModelSummary, TextElement, TimelineSkillMention, UserInput } from "../api/client";
import type { ImageLightboxImage } from "../images/types";
import { useInputCapabilities } from "../shared/inputCapabilities";
import { InlineComposerPanel } from "./InlineComposerPanel";
import { MobileComposerPanel } from "./MobileComposerPanel";
import { filterSlashCommands, replaceSlashCommandToken, slashCommandItems } from "./slashCommands";
import { filterSkillsForQuery } from "./skillMentions";
import type { PendingAttachment, QueuedSteerRow } from "./types";
import { useComposerDraftState, type ComposerDraftStore } from "./useComposerDraftState";
import { useSkillCatalog } from "./useSkillCatalog";

export type ComposerDraftControls = {
  clearText: () => void;
  restoreText: (text: string) => void;
};

type ComposerProjectOption = {
  id: string;
  name: string;
};

export type ComposerPanelProps = {
  activeSelectedTurnId: string | null;
  attachmentInputRef: RefObject<HTMLInputElement | null>;
  canCompose: boolean;
  composerSettings: ComposerSettings;
  composerSettingsError: string | null;
  composerResetToken: number;
  composerDraftKey?: string;
  composerDraftStore?: ComposerDraftStore;
  composerCwd?: string | null;
  composerShellRef?: RefObject<HTMLDivElement | null>;
  contextUsage?: ContextUsage | null;
  currentProjectName?: string | null;
  draftProjectSelector?: {
    onChange: (projectId: string | null) => void;
    projects: ComposerProjectOption[];
    value: string | null;
  };
  selectedGitBranch?: string | null;
  isDraftThreadSelected: boolean;
  isDraftComposerTransitioning: boolean;
  isComposerDragActive: boolean;
  isComposerSubmitting: boolean;
  isQueuedTurnStartPending?: boolean;
  isSelectedTimelineReady: boolean;
  skillsInvalidationGeneration?: number;
  models: ModelSummary[];
  onAbortQueuedSteer: (row: QueuedSteerRow) => void;
  onAttachmentInputChange: (event: ReactChangeEvent<HTMLInputElement>) => void;
  onComposerDragLeave: (event: ReactDragEvent<HTMLElement>) => void;
  onComposerDragOver: (event: ReactDragEvent<HTMLElement>) => void;
  onComposerDrop: (event: ReactDragEvent<HTMLElement>) => void;
  onComposerKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
  onComposerPaste: (event: ReactClipboardEvent<HTMLTextAreaElement>) => void;
  onComposerSettingsChange: (settings: ComposerSettings) => void;
  onImageOpen: (image: ImageLightboxImage) => void;
  onRemovePendingAttachment: (id: string) => void;
  onStopTurn: () => void;
  onSubmitQueuedSteer: (row: QueuedSteerRow) => void;
  onSubmitTurn: (
    event: FormEvent,
    draftText: string,
    controls: ComposerDraftControls,
    skillInputs: UserInput[],
    skillTextElements: TextElement[],
    skillMentions: TimelineSkillMention[],
  ) => void;
  pendingAttachments: PendingAttachment[];
  queuedSteerRows: QueuedSteerRow[];
  selectedThreadPresent: boolean;
};

export function ComposerPanel({
  activeSelectedTurnId,
  attachmentInputRef,
  canCompose,
  composerSettings,
  composerSettingsError,
  composerResetToken,
  composerDraftKey,
  composerDraftStore,
  composerCwd,
  composerShellRef,
  contextUsage,
  currentProjectName,
  draftProjectSelector,
  selectedGitBranch,
  isDraftThreadSelected,
  isDraftComposerTransitioning,
  isComposerDragActive,
  isComposerSubmitting,
  isQueuedTurnStartPending,
  isSelectedTimelineReady,
  skillsInvalidationGeneration = 0,
  models,
  onAbortQueuedSteer,
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
  onSubmitQueuedSteer,
  onSubmitTurn,
  pendingAttachments,
  queuedSteerRows,
  selectedThreadPresent,
}: ComposerPanelProps) {
  const draftState = useComposerDraftState(composerResetToken, composerDraftKey, composerDraftStore);
  const isNarrowComposer = useIsNarrowComposer();
  const inputCapabilities = useInputCapabilities();
  const isMobileComposer = isNarrowComposer && inputCapabilities.hasTouchInput;
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const internalComposerShellRef = useRef<HTMLDivElement | null>(null);
  const isComposerBusy = isComposerSubmitting || Boolean(isQueuedTurnStartPending);
  const isEntryPending = selectedThreadPresent && !isSelectedTimelineReady && !isDraftComposerTransitioning;
  const isComposerDisabled = !canCompose || isComposerBusy;
  const isComposerControlsDisabled = isComposerDisabled || isEntryPending;
  const canSubmitComposer =
    !isComposerControlsDisabled && (Boolean(draftState.composerText.trim()) || pendingAttachments.length > 0);
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
    });
  }, [activeSelectedTurnId, selectedThreadPresent]);
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
    onComposerKeyDown(event);
  }

  const setComposerShellNode = useCallback((node: HTMLDivElement | null) => {
    internalComposerShellRef.current = node;
    if (composerShellRef) {
      composerShellRef.current = node;
    }
  }, [composerShellRef]);

  const representationProps = {
    activeSelectedTurnId,
    attachmentInputRef,
    canCompose,
    canSubmitComposer,
    composerCwd,
    composerResetToken,
    composerSettings,
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
    isComposerSubmitting,
    isDraftComposerTransitioning,
    isDraftThreadSelected,
    isEntryPending,
    isQueuedTurnStartPending,
    isSelectedTimelineReady,
    models,
    onAbortQueuedSteer,
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
    onSubmitQueuedSteer,
    onSubmitTurn,
    pendingAttachments,
    queuedSteerRows,
    selectedGitBranch,
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

  return isMobileComposer ? (
    <MobileComposerPanel {...representationProps} />
  ) : (
    <InlineComposerPanel {...representationProps} />
  );
}

function useIsNarrowComposer() {
  const [isNarrow, setIsNarrow] = useState(() => readIsNarrowComposer());

  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      return;
    }

    const mediaQuery = window.matchMedia("(max-width: 900px)");
    function updateNarrowComposer() {
      setIsNarrow(mediaQuery.matches);
    }

    updateNarrowComposer();
    mediaQuery.addEventListener("change", updateNarrowComposer);
    return () => mediaQuery.removeEventListener("change", updateNarrowComposer);
  }, []);

  return isNarrow;
}

function readIsNarrowComposer() {
  return typeof window.matchMedia === "function" && window.matchMedia("(max-width: 900px)").matches;
}
