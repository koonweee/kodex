import { ActionIcon, Box, Group, Menu, Textarea, Tooltip } from "@mantine/core";
import { ArrowUp, Paperclip, Plus, Square } from "lucide-react";
import type {
  ChangeEvent as ReactChangeEvent,
  DragEvent as ReactDragEvent,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  RefObject,
} from "react";

import { ComposerFooterControls, type ComposerSettings, type ContextUsage } from "../ComposerFooterControls";
import type { ModelSummary } from "../api/client";
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
  send: "Send message",
  stop: "Stop turn",
};

export function ComposerPanel({
  attachmentInputRef,
  canCompose,
  canSubmitComposer,
  composerSettings,
  composerSettingsError,
  composerText,
  composerShellRef,
  contextUsage,
  isDraftComposerTransitioning,
  isComposerDragActive,
  isComposerSubmitting,
  isSelectedTimelineReady,
  models,
  onAbortQueuedSteer,
  onAttachmentInputChange,
  onComposerDragLeave,
  onComposerDragOver,
  onComposerDrop,
  onComposerKeyDown,
  onComposerSettingsChange,
  onComposerTextChange,
  onRemovePendingAttachment,
  onStopTurn,
  onSubmitQueuedSteer,
  onSubmitTurn,
  pendingAttachments,
  queuedSteerRows,
  selectedThreadPresent,
  shouldShowStopAction,
}: {
  attachmentInputRef: RefObject<HTMLInputElement | null>;
  canCompose: boolean;
  canSubmitComposer: boolean;
  composerSettings: ComposerSettings;
  composerSettingsError: string | null;
  composerText: string;
  composerShellRef?: RefObject<HTMLDivElement | null>;
  contextUsage?: ContextUsage | null;
  isDraftComposerTransitioning: boolean;
  isComposerDragActive: boolean;
  isComposerSubmitting: boolean;
  isSelectedTimelineReady: boolean;
  models: ModelSummary[];
  onAbortQueuedSteer: (row: QueuedSteerRow) => void;
  onAttachmentInputChange: (event: ReactChangeEvent<HTMLInputElement>) => void;
  onComposerDragLeave: (event: ReactDragEvent<HTMLElement>) => void;
  onComposerDragOver: (event: ReactDragEvent<HTMLElement>) => void;
  onComposerDrop: (event: ReactDragEvent<HTMLElement>) => void;
  onComposerKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
  onComposerSettingsChange: (settings: ComposerSettings) => void;
  onComposerTextChange: (value: string) => void;
  onRemovePendingAttachment: (id: string) => void;
  onStopTurn: () => void;
  onSubmitQueuedSteer: (row: QueuedSteerRow) => void;
  onSubmitTurn: (event: FormEvent) => void;
  pendingAttachments: PendingAttachment[];
  queuedSteerRows: QueuedSteerRow[];
  selectedThreadPresent: boolean;
  shouldShowStopAction: boolean;
}) {
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
      {queuedSteerRows.length > 0 ? (
        <QueuedSteerCard
          rows={queuedSteerRows}
          onAbortRow={onAbortQueuedSteer}
          onSubmitRow={onSubmitQueuedSteer}
        />
      ) : null}
      <Box component="form" className="kodex-composer" onSubmit={onSubmitTurn}>
        <input
          ref={attachmentInputRef}
          aria-label={COMPOSER_TEXT.addAttachment}
          className="kodex-attachment-input"
          type="file"
          accept="image/*"
          multiple
          disabled={!canCompose || isComposerSubmitting}
          onChange={onAttachmentInputChange}
        />
        {pendingAttachments.length > 0 && !isComposerSubmitting ? (
          <AttachmentTray attachments={pendingAttachments} onRemove={onRemovePendingAttachment} />
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
            if (!isComposerSubmitting) {
              onComposerTextChange(event.currentTarget.value);
            }
          }}
          onKeyDown={onComposerKeyDown}
          disabled={!canCompose || isComposerSubmitting}
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
                  disabled={!canCompose || isComposerSubmitting}
                >
                  <Plus size={16} />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown aria-label={COMPOSER_TEXT.attachments}>
                <Menu.Item
                  disabled={!canCompose || isComposerSubmitting}
                  leftSection={<Paperclip size={14} />}
                  onClick={() => attachmentInputRef.current?.click()}
                >
                  {COMPOSER_TEXT.addAttachment}
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
            <ComposerFooterControls
              contextUsage={contextUsage}
              disabled={!canCompose || isComposerSubmitting}
              models={models}
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
    </Box>
  );
}
