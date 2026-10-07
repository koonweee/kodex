import { Box, Text } from "@mantine/core";
import { Minimize2 } from "lucide-react";
import { useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from "react";

import type { SkillMetadata } from "../api/client";
import type { GoalControls } from "../goals/GoalControls";
import { AdaptiveIconButton } from "../ui/AdaptiveIconButton";
import type { ComposerPanelProps } from "./ComposerPanel";
import { InlineComposerPanel } from "./InlineComposerPanel";
import { MobileSlashCommandSheet } from "./MobileSlashCommandSheet";
import { MobileSkillCommandSheet } from "./MobileSkillCommandSheet";
import type { SlashCommandItem } from "./slashCommands";
import type { ComposerDraftState } from "./useComposerDraftState";
import { useComposerKeyboardViewport } from "./useComposerKeyboardViewport";
import type { SkillCatalogState } from "./useSkillCatalog";

const MOBILE_COMPOSER_TEXT = {
  collapse: "Collapse composer",
  compose: "Compose",
};

type MobileComposerPanelProps = ComposerPanelProps & {
  goalControls?: GoalControls;
  queuePanel?: ReactNode;
  queueOnSubmit?: boolean;
  canSubmitComposer: boolean;
  draftState: ComposerDraftState;
  filteredSkills: SkillMetadata[];
  filteredSlashCommands: SlashCommandItem[];
  handleTextareaKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
  isComposerBusy: boolean;
  isComposerControlsDisabled: boolean;
  isComposerDisabled: boolean;
  isEntryPending: boolean;
  selectSkill: (skillIndex?: number) => void;
  selectSlashCommand: (commandIndex?: number) => void;
  setComposerShellNode: (node: HTMLDivElement | null) => void;
  shouldShowStopAction: boolean;
  skillCatalog: SkillCatalogState;
  skillPopupOpen: boolean;
  slashPopupOpen: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
};

export function MobileComposerPanel({
  attachmentInputRef,
  canCompose,
  canSubmitComposer,
  composerSettings,
  composerSettingsDisabled,
  composerSettingsError,
  contextUsage,
  draftState,
  filteredSkills,
  filteredSlashCommands,
  handleTextareaKeyDown,
  isComposerBusy,
  isComposerControlsDisabled,
  isComposerDisabled,
  isComposerDragActive,
  isComposerSubmitting,
  models,
  onAttachmentInputChange,
  onComposerPaste,
  onComposerSettingsChange,
  onImageOpen,
  onRemovePendingAttachment,
  onStopTurn,
  onSubmitTurn,
  pendingAttachments,
  selectedThreadPresent,
  selectSkill,
  selectSlashCommand,
  setComposerShellNode,
  shouldShowStopAction,
  skillCatalog,
  skillPopupOpen,
  slashPopupOpen,
  textareaRef,
  ...inlineComposerProps
}: MobileComposerPanelProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const keyboardViewport = useComposerKeyboardViewport();
  const expandedStyle = {
    "--kodex-mobile-keyboard-inset": `${keyboardViewport.keyboardInset}px`,
    "--kodex-mobile-visual-viewport-offset-top": `${keyboardViewport.viewportOffsetTop}px`,
    "--kodex-mobile-visual-viewport-height": `${keyboardViewport.viewportHeight}px`,
    "--kodex-mobile-bottom-safe-area": keyboardViewport.keyboardInset > 0 ? "0px" : undefined,
  } as CSSProperties;
  function renderSkillCommandSheet() {
    if (skillPopupOpen) {
      return (
        <MobileSkillCommandSheet
          activeIndex={draftState.activeSkillIndex}
          error={skillCatalog.error}
          loading={skillCatalog.loading}
          skills={filteredSkills}
          onSelect={(skill) => selectSkill(filteredSkills.findIndex((item) => item.path === skill.path))}
        />
      );
    }
    if (slashPopupOpen) {
      return (
        <MobileSlashCommandSheet
          activeIndex={draftState.activeSlashIndex}
          commands={filteredSlashCommands}
          onSelect={(command) =>
            selectSlashCommand(filteredSlashCommands.findIndex((item) => item.id === command.id))
          }
        />
      );
    }
    return null;
  }

  // Keep the directly focused textarea mounted while its layout expands. Replacing
  // it and focusing a new input after the tap can dismiss the iOS keyboard.
  return (
    <>
      {isExpanded ? <Box aria-hidden="true" className="kodex-mobile-composer-keyboard-mask" /> : null}
      <InlineComposerPanel
        {...inlineComposerProps}
        attachmentInputRef={attachmentInputRef}
        canCompose={canCompose}
        canSubmitComposer={canSubmitComposer}
        composerSettings={composerSettings}
        composerSettingsDisabled={composerSettingsDisabled}
        composerSettingsError={composerSettingsError}
        contextUsage={contextUsage}
        density="mobile"
        expanded={isExpanded ? {
          style: expandedStyle,
          header: (
            <Box className="kodex-mobile-composer-expanded-header">
              <span aria-hidden="true" />
              <Text fw={700} size="sm">{MOBILE_COMPOSER_TEXT.compose}</Text>
              <AdaptiveIconButton label={MOBILE_COMPOSER_TEXT.collapse} onClick={() => setIsExpanded(false)}>
                <Minimize2 />
              </AdaptiveIconButton>
            </Box>
          ),
        } : undefined}
        draftState={draftState}
        filteredSkills={filteredSkills}
        filteredSlashCommands={filteredSlashCommands}
        handleTextareaKeyDown={handleTextareaKeyDown}
        isComposerBusy={isComposerBusy}
        isComposerControlsDisabled={isComposerControlsDisabled}
        isComposerDisabled={isComposerDisabled}
        isComposerDragActive={isComposerDragActive}
        isComposerSubmitting={isComposerSubmitting}
        models={models}
        onAttachmentInputChange={onAttachmentInputChange}
        onComposerPaste={onComposerPaste}
        onComposerSettingsChange={onComposerSettingsChange}
        onFocusComposer={() => setIsExpanded(true)}
        onImageOpen={onImageOpen}
        onRemovePendingAttachment={onRemovePendingAttachment}
        onStopTurn={onStopTurn}
        onSubmitTurn={(...args) => {
          onSubmitTurn(...args);
          if (canSubmitComposer) {
            setIsExpanded(false);
          }
        }}
        pendingAttachments={pendingAttachments}
        selectedThreadPresent={selectedThreadPresent}
        selectSkill={selectSkill}
        selectSlashCommand={selectSlashCommand}
        setComposerShellNode={setComposerShellNode}
        shouldShowStopAction={shouldShowStopAction}
        skillCatalog={skillCatalog}
        skillPopupOpen={skillPopupOpen}
        slashPopupOpen={slashPopupOpen}
        renderSkillSuggestions={renderSkillCommandSheet}
        textareaRef={textareaRef}
      />
    </>
  );
}
