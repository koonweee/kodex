import { Group, Loader, Menu } from "@mantine/core";
import { ArrowUp, ListPlus, Maximize2, Paperclip, Plus, Square, Target } from "lucide-react";
import { memo } from "react";
import type { RefObject } from "react";

import { ComposerFooterControls } from "../ComposerFooterControls";
import type { ComposerModelChoice, ComposerSettings, ComposerSettingsChange, ContextUsage } from "../ComposerFooterControls";
import { GoalButton, type GoalControls } from "../goals/GoalControls";
import { AdaptiveIconButton } from "../ui/AdaptiveIconButton";
import { useTouchQueueHold } from "./useTouchQueueHold";
import "./touchQueueHold.css";

const COMPOSER_TOOLBAR_TEXT = {
  addAttachment: "Add attachment",
  attachments: "Attachment options",
  expand: "Expand composer",
  openAttachments: "Open attachment menu",
  send: "Send message",
  addToQueue: "Add to queue",
  sending: "Sending message",
  stop: "Stop turn",
};

type ComposerToolbarProps = {
  goalControls?: GoalControls;
  formId: string;
  attachmentInputRef: RefObject<HTMLInputElement | null>;
  canSubmitComposer: boolean;
  contextUsage?: ContextUsage | null;
  disabled: boolean;
  models: ComposerModelChoice[];
  onExpandComposer?: () => void;
  onSettingsChange: (settings: ComposerSettingsChange) => void;
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
  formId,
  goalControls,
  attachmentInputRef,
  canSubmitComposer,
  contextUsage,
  disabled,
  models,
  onExpandComposer,
  onSettingsChange,
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
  const queueHold = useTouchQueueHold({
    enabled: selectedThreadPresent && canSubmitComposer && !disabled && !isSubmitting && !shouldShowStopAction,
    onQueue: () => {
      const form = document.getElementById(formId) as HTMLFormElement | null;
      const submitter = form?.querySelector<HTMLButtonElement>('button[hidden][data-submit-intent="queue"]');
      if (submitter && !submitter.disabled) form?.requestSubmit(submitter);
    },
  });
  const actionLabel = isSubmitting
    ? COMPOSER_TOOLBAR_TEXT.sending
    : shouldShowStopAction
      ? COMPOSER_TOOLBAR_TEXT.stop
      : queueOnSubmit ? COMPOSER_TOOLBAR_TEXT.addToQueue : COMPOSER_TOOLBAR_TEXT.send;

  return (
    <Group className="kodex-composer-toolbar" justify="space-between" wrap="wrap">
      <Group className="kodex-composer-toolbar-left" gap={6} wrap="nowrap">
        <Menu position="top-start" withinPortal>
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
                title="Queue message (⌘Enter on desktop)"
              >
                Queue message
              </Menu.Item>
            ) : null}
          </Menu.Dropdown>
        </Menu>
        <ComposerFooterControls
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
      {onExpandComposer ? (
        <AdaptiveIconButton
          className="kodex-composer-secondary-action kodex-composer-expand-action"
          disabled={disabled}
          label={COMPOSER_TOOLBAR_TEXT.expand}
          onClick={onExpandComposer}
        >
          <Maximize2 />
        </AdaptiveIconButton>
      ) : null}
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
          tooltip={selectedThreadPresent ? `${actionLabel} · Hold to queue on touch` : actionLabel}
          type="submit"
          {...queueHold.handlers}
        >
          {queueOnSubmit ? <ListPlus /> : <ArrowUp />}
          {queueHold.holding ? <span className="kodex-composer-hold-progress" aria-hidden="true">
            <svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="14" pathLength="100" /></svg>
          </span> : null}
        </AdaptiveIconButton>
      )}
    </Group>
  );
});
