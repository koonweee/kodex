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
import type { ModelSummary, PermissionProfileSummary, TextElement, TimelineSkillMention, UserInput } from "../api/client";
import type { ImageLightboxImage } from "../images/types";
import { useInputCapabilities } from "../shared/inputCapabilities";
import { InlineComposerPanel } from "./InlineComposerPanel";
import { MobileComposerPanel } from "./MobileComposerPanel";
import { filterSkillsForQuery } from "./skillMentions";
import type { PendingAttachment, QueuedSteerRow } from "./types";
import { useComposerDraftState } from "./useComposerDraftState";
import { usePermissionProfiles } from "./usePermissionProfiles";
import { useSkillCatalog } from "./useSkillCatalog";

export type ComposerDraftControls = {
  clearText: () => void;
  restoreText: (text: string) => void;
};

export type ComposerProjectOption = {
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
  permissionProfiles?: PermissionProfileSummary[];
  permissionProfilesError?: string | null;
  permissionProfilesLoading?: boolean;
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
  const draftState = useComposerDraftState(composerResetToken, composerDraftKey);
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
  const skillCatalog = useSkillCatalog({
    cwd: composerCwd,
    enabled: skillPopupOpen,
    invalidationGeneration: skillsInvalidationGeneration,
  });
  const permissionProfiles = usePermissionProfiles({ cwd: composerCwd });
  const filteredSkills = useMemo(
    () => filterSkillsForQuery(skillCatalog.skills, draftState.skillToken?.query ?? ""),
    [skillCatalog.skills, draftState.skillToken?.query],
  );

  useEffect(() => {
    draftState.clampActiveSkillIndex(filteredSkills.length);
  }, [filteredSkills.length]);

  useEffect(() => {
    if (!skillPopupOpen) {
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
    }

    document.addEventListener("pointerdown", handleDocumentPointerDown);
    return () => document.removeEventListener("pointerdown", handleDocumentPointerDown);
  }, [skillPopupOpen]);

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
    permissionProfiles: permissionProfiles.profiles,
    permissionProfilesError: permissionProfiles.error,
    permissionProfilesLoading: permissionProfiles.isLoading,
    queuedSteerRows,
    selectedGitBranch,
    selectedThreadPresent,
    selectSkill,
    setComposerShellNode,
    shouldShowStopAction,
    skillCatalog,
    skillPopupOpen,
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
