import { ActionIcon, Group, Menu, Tooltip } from "@mantine/core";
import { ArrowUp, Maximize2, Paperclip, Plus, Square } from "lucide-react";
import type { RefObject } from "react";

import { ComposerFooterControls } from "../ComposerFooterControls";
import type { ComposerSettings, ContextUsage } from "../ComposerFooterControls";
import type { ModelSummary } from "../api/client";

const COMPOSER_TOOLBAR_TEXT = {
  addAttachment: "Add attachment",
  attachments: "Attachment options",
  expand: "Expand composer",
  openAttachments: "Open attachment menu",
  send: "Send message",
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
  showContextUsage?: boolean;
};

export function ComposerToolbar({
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
  showContextUsage = true,
}: ComposerToolbarProps) {
  return (
    <Group className="kodex-composer-toolbar" justify="space-between" wrap="wrap">
      <Group className="kodex-composer-toolbar-left" gap={6} wrap="nowrap">
        <Menu position="top-start" withinPortal>
          <Menu.Target>
            <ActionIcon
              aria-label={COMPOSER_TOOLBAR_TEXT.openAttachments}
              className="kodex-composer-secondary-action"
              size="md"
              type="button"
              variant="subtle"
              disabled={disabled}
            >
              <Plus size={16} />
            </ActionIcon>
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
        <Tooltip label={COMPOSER_TOOLBAR_TEXT.expand}>
          <ActionIcon
            aria-label={COMPOSER_TOOLBAR_TEXT.expand}
            className="kodex-composer-secondary-action kodex-composer-expand-action"
            size="md"
            type="button"
            variant="subtle"
            onClick={onExpandComposer}
          >
            <Maximize2 size={15} />
          </ActionIcon>
        </Tooltip>
      ) : null}
      <Tooltip label={shouldShowStopAction ? COMPOSER_TOOLBAR_TEXT.stop : COMPOSER_TOOLBAR_TEXT.send}>
        {shouldShowStopAction ? (
          <ActionIcon
            className="kodex-composer-action"
            data-action-state="active"
            aria-label={COMPOSER_TOOLBAR_TEXT.stop}
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
            aria-label={COMPOSER_TOOLBAR_TEXT.send}
            size="md"
            type="submit"
            disabled={!canSubmitComposer}
          >
            <ArrowUp size={16} />
          </ActionIcon>
        )}
      </Tooltip>
    </Group>
  );
}
