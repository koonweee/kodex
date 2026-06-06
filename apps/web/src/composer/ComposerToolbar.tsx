import { Group, Loader, Menu } from "@mantine/core";
import { ArrowUp, Maximize2, Paperclip, Plus, Square } from "lucide-react";
import { memo } from "react";
import type { RefObject } from "react";

import { ComposerFooterControls } from "../ComposerFooterControls";
import type { ComposerSettings, ContextUsage } from "../ComposerFooterControls";
import type { ModelSummary } from "../api/client";
import { AdaptiveIconButton } from "../ui/AdaptiveIconButton";

const COMPOSER_TOOLBAR_TEXT = {
  addAttachment: "Add attachment",
  attachments: "Attachment options",
  expand: "Expand composer",
  openAttachments: "Open attachment menu",
  send: "Send message",
  sending: "Sending message",
  stop: "Stop turn",
};

type ComposerToolbarProps = {
  attachmentInputRef: RefObject<HTMLInputElement | null>;
  canSubmitComposer: boolean;
  contextUsage?: ContextUsage | null;
  disabled: boolean;
  models: ModelSummary[];
  onExpandComposer?: () => void;
  onSettingsChange: (settings: ComposerSettings) => void;
  onStopTurn: () => void;
  selectedThreadPresent: boolean;
  settings: ComposerSettings;
  settingsError?: string | null;
  shouldShowStopAction: boolean;
  isSubmitting: boolean;
  showContextUsage?: boolean;
};

export const ComposerToolbar = memo(function ComposerToolbar({
  attachmentInputRef,
  canSubmitComposer,
  contextUsage,
  disabled,
  models,
  onExpandComposer,
  onSettingsChange,
  onStopTurn,
  selectedThreadPresent,
  settings,
  settingsError,
  shouldShowStopAction,
  isSubmitting,
  showContextUsage = true,
}: ComposerToolbarProps) {
  const actionLabel = isSubmitting
    ? COMPOSER_TOOLBAR_TEXT.sending
    : shouldShowStopAction
      ? COMPOSER_TOOLBAR_TEXT.stop
      : COMPOSER_TOOLBAR_TEXT.send;

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
          </Menu.Dropdown>
        </Menu>
        <ComposerFooterControls
          contextUsage={contextUsage}
          disabled={disabled}
          models={models}
          showContextUsage={showContextUsage}
          settingsError={settingsError}
          settings={settings}
          onSettingsChange={onSettingsChange}
        />
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
          label={COMPOSER_TOOLBAR_TEXT.send}
          tooltip={actionLabel}
          type="submit"
        >
          <ArrowUp />
        </AdaptiveIconButton>
      )}
    </Group>
  );
});
