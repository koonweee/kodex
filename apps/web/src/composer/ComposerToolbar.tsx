import { Group, Loader, Menu } from "@mantine/core";
import { ArrowUp, ListPlus, Paperclip, Plus, Square, Target } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import { ComposerFooterControls } from "../ComposerFooterControls";
import type { ComposerSettings, ComposerSettingsChange, ContextUsage } from "../ComposerFooterControls";
import type { ModelSummary } from "../api/client";
import { GoalButton, type GoalControls } from "../goals/GoalControls";
import { AdaptiveIconButton } from "../ui/AdaptiveIconButton";
import { useQueueHold } from "./useQueueHold";
import "./queueHold.css";

const COMPOSER_TOOLBAR_TEXT = {
  addAttachment: "Add attachment",
  attachments: "Attachment options",
  openAttachments: "Open attachment menu",
  send: "Send message",
  sendNow: "Send now",
  addToQueue: "Add to queue",
  sending: "Sending message",
  stop: "Stop turn",
};

type ComposerToolbarProps = {
  alternateSubmitPreview?: boolean;
  goalControls?: GoalControls;
  formId: string;
  attachmentInputRef: RefObject<HTMLInputElement | null>;
  canSubmitComposer: boolean;
  contextUsage?: ContextUsage | null;
  disabled: boolean;
  models: ModelSummary[];
  onSettingsChange: (settings: ComposerSettingsChange) => void;
  onMenuOpenChange?: (opened: boolean) => void;
  onStopTurn: () => void;
  selectedThreadPresent: boolean;
  queueOnSubmit?: boolean;
  settings: ComposerSettings | null;
  settingsDisabled?: boolean;
  settingsError?: string | null;
  shouldShowStopAction: boolean;
  isSubmitting: boolean;
  showContextUsage?: boolean;
};

export const ComposerToolbar = memo(function ComposerToolbar({
  alternateSubmitPreview = false,
  formId,
  goalControls,
  attachmentInputRef,
  canSubmitComposer,
  contextUsage,
  disabled,
  models,
  onSettingsChange,
  onMenuOpenChange,
  onStopTurn,
  selectedThreadPresent,
  queueOnSubmit = false,
  settings,
  settingsDisabled,
  settingsError,
  shouldShowStopAction,
  isSubmitting,
  showContextUsage = true,
}: ComposerToolbarProps) {
  const attachmentTargetRef = useRef<HTMLSpanElement>(null);
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  useEffect(() => {
    if (!disabled) return;
    setAttachmentMenuOpen(false);
  }, [disabled]);
  useEffect(() => {
    onMenuOpenChange?.(attachmentMenuOpen || modelMenuOpen);
  }, [attachmentMenuOpen, modelMenuOpen, onMenuOpenChange]);
  function changeAttachmentMenuOpen(opened: boolean) {
    if (!opened && attachmentMenuOpen) {
      attachmentTargetRef.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    }
    setAttachmentMenuOpen(opened);
  }
  const queueHold = useQueueHold({
    enabled: selectedThreadPresent && canSubmitComposer && !disabled && !isSubmitting && !shouldShowStopAction,
    onQueue: () => {
      const form = document.getElementById(formId) as HTMLFormElement | null;
      const submitter = form?.querySelector<HTMLButtonElement>('button[hidden][data-submit-intent="queue"]');
      if (submitter && !submitter.disabled) form?.requestSubmit(submitter);
    },
  });
  const previewQueueAction = alternateSubmitPreview !== queueOnSubmit;
  const previewSendNowAction = alternateSubmitPreview && queueOnSubmit;
  const actionLabel = isSubmitting
    ? COMPOSER_TOOLBAR_TEXT.sending
    : shouldShowStopAction
      ? COMPOSER_TOOLBAR_TEXT.stop
      : previewQueueAction
        ? COMPOSER_TOOLBAR_TEXT.addToQueue
        : previewSendNowAction ? COMPOSER_TOOLBAR_TEXT.sendNow : COMPOSER_TOOLBAR_TEXT.send;

  return (
    <Group className="kodex-composer-toolbar" gap={4} justify="space-between" wrap="wrap">
      <Group className="kodex-composer-toolbar-left" gap={4} wrap="nowrap">
        <Menu position="top-start" withinPortal returnFocus={false} opened={!disabled && attachmentMenuOpen} onChange={changeAttachmentMenuOpen}>
          <span ref={attachmentTargetRef} className="kodex-composer-attachment-target">
            <Menu.Target>
              <AdaptiveIconButton
                className="kodex-composer-secondary-action"
                disabled={disabled}
                label={COMPOSER_TOOLBAR_TEXT.openAttachments}
                tooltip={false}
              >
                <Plus />
              </AdaptiveIconButton>
            </Menu.Target>
          </span>
          <Menu.Dropdown aria-label={COMPOSER_TOOLBAR_TEXT.attachments}>
            <Menu.Item
              disabled={disabled}
              leftSection={<Paperclip size={14} />}
              onClick={() => attachmentInputRef.current?.click()}
            >
              {COMPOSER_TOOLBAR_TEXT.addAttachment}
            </Menu.Item>
            {goalControls?.ready && !goalControls.goal ? (
              <Menu.Item leftSection={<Target size={14} />} disabled={goalControls.pending} onClick={goalControls.onOpen}>
                Set goal
              </Menu.Item>
            ) : null}
            {goalControls?.error ? <Menu.Item onClick={goalControls.onReload}>Reload goal</Menu.Item> : null}
            {selectedThreadPresent ? (
              <Menu.Item
                disabled={!canSubmitComposer}
                leftSection={<ListPlus size={14} />}
                type="submit"
                form={formId}
                data-submit-intent="queue"
                title="Queue message"
              >
                Queue message
              </Menu.Item>
            ) : null}
          </Menu.Dropdown>
        </Menu>
        <ComposerFooterControls
          onMenuOpenChange={setModelMenuOpen}
          contextUsage={contextUsage}
          disabled={disabled || settingsDisabled}
          models={models}
          showContextUsage={showContextUsage}
          settingsError={settingsError}
          settings={settings}
          onSettingsChange={onSettingsChange}
        />
        {goalControls && (goalControls.compact || (goalControls.error && !goalControls.goal)) ? <GoalButton controls={goalControls} /> : null}
      </Group>
      {isSubmitting ? (
        <AdaptiveIconButton
          className="kodex-composer-action"
          data-action-state="submitting"
          disabled
          label={COMPOSER_TOOLBAR_TEXT.sending}
        >
          <Loader aria-hidden="true" color="currentColor" size={16} />
        </AdaptiveIconButton>
      ) : shouldShowStopAction ? (
        <AdaptiveIconButton
          className="kodex-composer-action"
          data-action-state="active"
          disabled={!selectedThreadPresent}
          label={COMPOSER_TOOLBAR_TEXT.stop}
          onClick={onStopTurn}
          variant="filled"
        >
          <Square fill="currentColor" strokeWidth={0} />
        </AdaptiveIconButton>
      ) : (
        <AdaptiveIconButton
          className="kodex-composer-action"
          data-action-state="idle"
          disabled={!canSubmitComposer}
          label={actionLabel}
          tooltip={selectedThreadPresent ? `${actionLabel} · Hold to queue` : actionLabel}
          type="submit"
          data-submit-intent={alternateSubmitPreview ? "alternate" : undefined}
          {...queueHold.handlers}
        >
          {previewQueueAction ? <ListPlus /> : <ArrowUp />}
          {queueHold.holding ? <span className="kodex-composer-hold-progress" aria-hidden="true">
            <svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="14" pathLength="100" /></svg>
          </span> : null}
        </AdaptiveIconButton>
      )}
    </Group>
  );
});
