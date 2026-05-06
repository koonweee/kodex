import { ActionIcon, Box, Group, Menu, Textarea, Tooltip } from "@mantine/core";
import { ArrowUp, ChevronDown, Folder, GitGraph, MessageSquare, Paperclip, Plus, Square } from "lucide-react";
import { useEffect, useState } from "react";
import type {
  ClipboardEvent as ReactClipboardEvent,
  ChangeEvent as ReactChangeEvent,
  DragEvent as ReactDragEvent,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  RefObject,
} from "react";

import {
  ComposerFooterControls,
  type ComposerSettings,
  type ContextUsage,
} from "../ComposerFooterControls";
import type { ModelSummary } from "../api/client";
import type { ImageLightboxImage } from "../images/types";
import { AttachmentTray } from "./AttachmentTray";
import { QueuedSteerCard } from "./QueuedSteerCard";
import type { PendingAttachment, QueuedSteerRow } from "./types";

const COMPOSER_TEXT = {
  addAttachment: "Add attachment",
  attachments: "Attachment options",
  disabledPlaceholder: "Select a thread to start composing",
  dropImages: "Drop images to attach",
  openAttachments: "Open attachment menu",
  placeholder: "type clever thing here",
  projectSelector: "Project",
  noProject: "No project",
  send: "Send message",
  stop: "Stop turn",
};

export type ComposerDraftControls = {
  clearText: () => void;
  restoreText: (text: string) => void;
};

export type ComposerProjectOption = {
  id: string;
  name: string;
};

export function ComposerPanel({
  activeSelectedTurnId,
  attachmentInputRef,
  canCompose,
  composerSettings,
  composerSettingsError,
  composerResetToken,
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
}: {
  activeSelectedTurnId: string | null;
  attachmentInputRef: RefObject<HTMLInputElement | null>;
  canCompose: boolean;
  composerSettings: ComposerSettings;
  composerSettingsError: string | null;
  composerResetToken: number;
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
  onSubmitTurn: (event: FormEvent, draftText: string, controls: ComposerDraftControls) => void;
  pendingAttachments: PendingAttachment[];
  queuedSteerRows: QueuedSteerRow[];
  selectedThreadPresent: boolean;
}) {
  const [composerText, setComposerText] = useState("");
  const draftHeroText = greetingForDate(new Date());
  const shouldShowDraftHero = isDraftThreadSelected || isDraftComposerTransitioning;
  const selectedDraftProject =
    draftProjectSelector?.projects.find((project) => project.id === draftProjectSelector.value) ?? null;
  const draftProjectSelectorLabel = selectedDraftProject?.name ?? COMPOSER_TEXT.noProject;
  const draftProjectToolbarName =
    isDraftThreadSelected && !draftProjectSelector && currentProjectName ? currentProjectName : null;
  const selectedGitBranchName = normalizeUnderbarText(selectedGitBranch);
  const underbarItems = [
    draftProjectToolbarName
      ? { icon: "project" as const, label: draftProjectToolbarName, title: draftProjectToolbarName }
      : null,
    selectedGitBranchName
      ? { icon: "branch" as const, label: selectedGitBranchName, title: selectedGitBranchName }
      : null,
  ].filter((item): item is { icon: "project" | "branch"; label: string; title: string } => item !== null);
  const hasProjectSelector = draftProjectSelector !== undefined;
  const hasUnderbar = hasProjectSelector || underbarItems.length > 0;
  const underbarLabel = selectedGitBranchName ? "Composer context" : "Draft thread toolbar";
  const isComposerBusy = isComposerSubmitting || Boolean(isQueuedTurnStartPending);
  const canSubmitComposer =
    canCompose && !isComposerBusy && (Boolean(composerText.trim()) || pendingAttachments.length > 0);
  const shouldShowStopAction = activeSelectedTurnId !== null && !canSubmitComposer;

  useEffect(() => {
    setComposerText("");
  }, [composerResetToken]);

  return (
    <Box
      ref={composerShellRef}
      className="kodex-composer-shell kodex-main-column"
      data-entry-ready={
        selectedThreadPresent && !isSelectedTimelineReady && !isDraftComposerTransitioning ? "false" : "true"
      }
      data-drag-active={isComposerDragActive ? "true" : "false"}
      onDragLeave={onComposerDragLeave}
      onDragOver={onComposerDragOver}
      onDrop={onComposerDrop}
    >
      {shouldShowDraftHero ? (
        <Box
          className="kodex-composer-hero-stage"
          data-transitioning={isDraftComposerTransitioning ? "true" : "false"}
        >
          <Box className="kodex-composer-hero">{draftHeroText}</Box>
        </Box>
      ) : null}
      {queuedSteerRows.length > 0 ? (
        <QueuedSteerCard
          blockIdleStartActions={activeSelectedTurnId === null && Boolean(isQueuedTurnStartPending)}
          hasActiveTurn={activeSelectedTurnId !== null}
          rows={queuedSteerRows}
          onAbortRow={onAbortQueuedSteer}
          onSubmitRow={onSubmitQueuedSteer}
        />
      ) : null}
      <Box
        component="form"
        className={`kodex-composer${hasUnderbar ? " kodex-composer-with-underbar" : ""}`}
        onSubmit={(event) =>
          onSubmitTurn(event, composerText, {
            clearText: () => setComposerText(""),
            restoreText: setComposerText,
          })
        }
      >
        <input
          ref={attachmentInputRef}
          aria-label={COMPOSER_TEXT.addAttachment}
          className="kodex-attachment-input"
          type="file"
          accept="image/*"
          multiple
          disabled={!canCompose || isComposerBusy}
          onChange={onAttachmentInputChange}
        />
        {pendingAttachments.length > 0 && !isComposerBusy ? (
          <AttachmentTray attachments={pendingAttachments} onImageOpen={onImageOpen} onRemove={onRemovePendingAttachment} />
        ) : null}
        <Textarea
          aria-label="Message composer"
          className="kodex-composer-textarea"
          placeholder={canCompose ? COMPOSER_TEXT.placeholder : COMPOSER_TEXT.disabledPlaceholder}
          minRows={2}
          maxRows={10}
          autosize
          value={composerText}
          onChange={(event) => {
            if (!isComposerBusy) {
              setComposerText(event.currentTarget.value);
            }
          }}
          onKeyDown={onComposerKeyDown}
          onPaste={onComposerPaste}
          disabled={!canCompose || isComposerBusy}
          variant="unstyled"
        />
        {isComposerDragActive ? (
          <Box className="kodex-composer-drop-hint" aria-hidden="true">
            {COMPOSER_TEXT.dropImages}
          </Box>
        ) : null}
        <Group className="kodex-composer-toolbar" justify="space-between" wrap="wrap">
          <Group className="kodex-composer-toolbar-left" gap={6} wrap="nowrap">
            <Menu position="top-start" withinPortal>
              <Menu.Target>
                <ActionIcon
                  aria-label={COMPOSER_TEXT.openAttachments}
                  className="kodex-composer-secondary-action"
                  size="md"
                  type="button"
                  variant="subtle"
                  disabled={!canCompose || isComposerBusy}
                >
                  <Plus size={16} />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown aria-label={COMPOSER_TEXT.attachments}>
                <Menu.Item
                  disabled={!canCompose || isComposerBusy}
                  leftSection={<Paperclip size={14} />}
                  onClick={() => attachmentInputRef.current?.click()}
                >
                  {COMPOSER_TEXT.addAttachment}
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
            <ComposerFooterControls
              contextUsage={contextUsage}
              disabled={!canCompose || isComposerBusy}
              models={models}
              showContextUsage={!shouldShowDraftHero}
              settingsError={composerSettingsError}
              settings={composerSettings}
              onSettingsChange={onComposerSettingsChange}
            />
          </Group>
          <Tooltip label={shouldShowStopAction ? COMPOSER_TEXT.stop : COMPOSER_TEXT.send}>
            {shouldShowStopAction ? (
              <ActionIcon
                className="kodex-composer-action"
                data-action-state="active"
                aria-label={COMPOSER_TEXT.stop}
                size="md"
                variant="filled"
                type="button"
                disabled={!selectedThreadPresent}
                onClick={onStopTurn}
              >
                <Square size={13} fill="currentColor" strokeWidth={0} />
              </ActionIcon>
            ) : (
              <ActionIcon
                className="kodex-composer-action"
                data-action-state="idle"
                aria-label={COMPOSER_TEXT.send}
                size="md"
                type="submit"
                disabled={!canSubmitComposer}
              >
                <ArrowUp size={16} />
              </ActionIcon>
            )}
          </Tooltip>
        </Group>
      </Box>
      {hasUnderbar ? (
        <Box className="kodex-composer-underbar" aria-label={underbarLabel} role="toolbar">
          <Group className="kodex-composer-underbar-left" gap={10} wrap="nowrap">
            {draftProjectSelector ? (
              <Menu position="top-start" withinPortal>
                <Menu.Target>
                  <button
                    aria-label={`${COMPOSER_TEXT.projectSelector}: ${draftProjectSelectorLabel}`}
                    className="kodex-composer-underbar-item kodex-composer-underbar-button"
                    type="button"
                  >
                    {selectedDraftProject ? <Folder size={15} /> : <MessageSquare size={15} />}
                    <span title={draftProjectSelectorLabel}>{draftProjectSelectorLabel}</span>
                    <ChevronDown className="kodex-composer-underbar-chevron" size={14} />
                  </button>
                </Menu.Target>
                <Menu.Dropdown aria-label={COMPOSER_TEXT.projectSelector}>
                  <Menu.Item
                    leftSection={<MessageSquare size={14} />}
                    onClick={() => draftProjectSelector.onChange(null)}
                  >
                    {COMPOSER_TEXT.noProject}
                  </Menu.Item>
                  {draftProjectSelector.projects.length > 0 ? <Menu.Divider /> : null}
                  {draftProjectSelector.projects.map((project) => (
                    <Menu.Item
                      key={project.id}
                      leftSection={<Folder size={14} />}
                      onClick={() => draftProjectSelector.onChange(project.id)}
                    >
                      {project.name}
                    </Menu.Item>
                  ))}
                </Menu.Dropdown>
              </Menu>
            ) : null}
            {underbarItems.map((item) => (
              <Group key={`${item.icon}:${item.label}`} className="kodex-composer-underbar-item" gap={8} wrap="nowrap">
                {item.icon === "project" ? <Folder size={15} /> : <GitGraph size={15} />}
                <span title={item.title}>{item.label}</span>
              </Group>
            ))}
          </Group>
        </Box>
      ) : null}
    </Box>
  );
}

function normalizeUnderbarText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function greetingForDate(date: Date) {
  const hour = date.getHours();
  if (hour < 5) {
    return "Burning the midnight oil?";
  }
  if (hour < 12) {
    return "Good morning";
  }
  if (hour < 17) {
    return "Good afternoon";
  }
  return "Good evening";
}
