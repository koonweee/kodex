import { ActionIcon, Box, Text, Textarea } from "@mantine/core";
import { Minimize2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, FormEvent, KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";

import type { SkillMetadata } from "../api/client";
import { AttachmentTray } from "./AttachmentTray";
import type { ComposerPanelProps } from "./ComposerPanel";
import { ComposerToolbar } from "./ComposerToolbar";
import { isTouchInputDevice } from "./inputCapabilities";
import { InlineComposerPanel } from "./InlineComposerPanel";
import { MobileSkillCommandSheet } from "./MobileSkillCommandSheet";
import type { ComposerDraftState } from "./useComposerDraftState";
import { useComposerKeyboardViewport } from "./useComposerKeyboardViewport";
import type { SkillCatalogState } from "./useSkillCatalog";

const MOBILE_COMPOSER_TEXT = {
  addAttachment: "Add attachment",
  collapse: "Collapse composer",
  compose: "Compose",
  dropImages: "Drop images to attach",
  placeholder: "type clever thing here",
};

type MobileComposerPanelProps = ComposerPanelProps & {
  canSubmitComposer: boolean;
  draftState: ComposerDraftState;
  filteredSkills: SkillMetadata[];
  handleTextareaKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
  isComposerBusy: boolean;
  isComposerControlsDisabled: boolean;
  isComposerDisabled: boolean;
  isEntryPending: boolean;
  selectSkill: (skillIndex?: number) => void;
  setComposerShellNode: (node: HTMLDivElement | null) => void;
  shouldShowStopAction: boolean;
  skillCatalog: SkillCatalogState;
  skillPopupOpen: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
};

export function MobileComposerPanel({
  attachmentInputRef,
  canCompose,
  canSubmitComposer,
  composerSettings,
  composerSettingsError,
  contextUsage,
  draftState,
  filteredSkills,
  handleTextareaKeyDown,
  isComposerBusy,
  isComposerControlsDisabled,
  isComposerDisabled,
  isComposerDragActive,
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
  setComposerShellNode,
  shouldShowStopAction,
  skillCatalog,
  skillPopupOpen,
  textareaRef,
  ...inlineComposerProps
}: MobileComposerPanelProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const shouldExpandOnFocus = useIsTouchDevice();
  const keyboardViewport = useComposerKeyboardViewport();
  const expandedStyle = {
    "--kodex-mobile-keyboard-inset": `${keyboardViewport.keyboardInset}px`,
    "--kodex-mobile-visual-viewport-offset-top": `${keyboardViewport.viewportOffsetTop}px`,
    "--kodex-mobile-visual-viewport-height": `${keyboardViewport.viewportHeight}px`,
  } as CSSProperties;
  const submitContent = useMemo(
    () => ({
      controls: {
        clearText: draftState.clearText,
        restoreText: draftState.restoreText,
      },
      text: draftState.composerText,
    }),
    [draftState.clearText, draftState.composerText, draftState.restoreText],
  );

  function openExpanded() {
    setIsExpanded(true);
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) {
        return;
      }

      textarea.focus({ preventScroll: true });
      const cursor = textarea.value.length;
      textarea.setSelectionRange(cursor, cursor);
    });
  }

  function handleSubmit(event: FormEvent) {
    onSubmitTurn(
      event,
      draftState.currentSubmittedText(),
      submitContent.controls,
      draftState.currentSkillInputs(),
      draftState.currentSkillTextElements(),
      draftState.currentTimelineSkillMentions(),
    );
    if (canSubmitComposer) {
      setIsExpanded(false);
    }
  }

  function renderHiddenAttachmentInput() {
    return (
      <input
        ref={attachmentInputRef}
        aria-label={MOBILE_COMPOSER_TEXT.addAttachment}
        className="kodex-attachment-input"
        type="file"
        accept="image/*"
        multiple
        disabled={isComposerControlsDisabled}
        onChange={onAttachmentInputChange}
      />
    );
  }

  function renderSkillCommandSheet() {
    return skillPopupOpen ? (
      <MobileSkillCommandSheet
        activeIndex={draftState.activeSkillIndex}
        error={skillCatalog.error}
        loading={skillCatalog.loading}
        skills={filteredSkills}
        onSelect={(skill) => selectSkill(filteredSkills.findIndex((item) => item.path === skill.path))}
      />
    ) : null;
  }

  return isExpanded ? (
    <>
      <Box aria-hidden="true" className="kodex-mobile-composer-keyboard-mask" style={expandedStyle} />
      <Box
        ref={setComposerShellNode}
        className="kodex-mobile-composer-expanded"
        role="dialog"
        aria-label={MOBILE_COMPOSER_TEXT.compose}
        style={expandedStyle}
      >
        <Box className="kodex-mobile-composer-expanded-header">
          <span aria-hidden="true" />
          <Text fw={700} size="sm">
            {MOBILE_COMPOSER_TEXT.compose}
          </Text>
          <ActionIcon
            aria-label={MOBILE_COMPOSER_TEXT.collapse}
            type="button"
            variant="subtle"
            onClick={() => setIsExpanded(false)}
          >
            <Minimize2 size={18} />
          </ActionIcon>
        </Box>
        <Box
          component="form"
          className="kodex-mobile-composer-expanded-body"
          data-skill-command-open={skillPopupOpen ? "true" : undefined}
          onSubmit={handleSubmit}
        >
          {renderHiddenAttachmentInput()}
          <Box
            className="kodex-mobile-composer-expanded-main"
            data-skill-command-open={skillPopupOpen ? "true" : undefined}
          >
            {pendingAttachments.length > 0 && !isComposerBusy ? (
              <AttachmentTray
                attachments={pendingAttachments}
                compact
                onImageOpen={onImageOpen}
                onRemove={onRemovePendingAttachment}
              />
            ) : null}
            <Textarea
              ref={textareaRef}
              aria-label="Message composer"
              className="kodex-mobile-composer-textarea"
              placeholder={canCompose ? MOBILE_COMPOSER_TEXT.placeholder : "Select a thread to start composing"}
              minRows={3}
              maxRows={16}
              autosize
              value={draftState.composerText}
              onChange={(event) => {
                if (!isComposerDisabled) {
                  draftState.updateComposerText(event.currentTarget.value, event.currentTarget.selectionStart);
                }
              }}
              onClick={(event) =>
                draftState.updateComposerText(event.currentTarget.value, event.currentTarget.selectionStart)
              }
              onKeyUp={(event) => {
                if (event.key !== "Escape") {
                  draftState.updateComposerText(event.currentTarget.value, event.currentTarget.selectionStart);
                }
              }}
              onKeyDown={isComposerControlsDisabled ? undefined : handleTextareaKeyDown}
              onPaste={isComposerControlsDisabled ? undefined : onComposerPaste}
              disabled={isComposerDisabled}
              variant="unstyled"
            />
            {renderSkillCommandSheet()}
          </Box>
          {isComposerDragActive ? (
            <Box className="kodex-composer-drop-hint" aria-hidden="true">
              {MOBILE_COMPOSER_TEXT.dropImages}
            </Box>
          ) : null}
          {skillPopupOpen ? null : (
            <Box className="kodex-mobile-composer-expanded-footer">
              <ComposerToolbar
                attachmentInputRef={attachmentInputRef}
                canSubmitComposer={canSubmitComposer}
                contextUsage={contextUsage}
                disabled={isComposerControlsDisabled}
                models={models}
                onSettingsChange={onComposerSettingsChange}
                onStopTurn={onStopTurn}
                selectedThreadPresent={selectedThreadPresent}
                settings={composerSettings}
                settingsError={composerSettingsError}
                shouldShowStopAction={shouldShowStopAction}
              />
            </Box>
          )}
        </Box>
      </Box>
    </>
  ) : (
    <InlineComposerPanel
      {...inlineComposerProps}
      attachmentInputRef={attachmentInputRef}
      canCompose={canCompose}
      canSubmitComposer={canSubmitComposer}
      composerSettings={composerSettings}
      composerSettingsError={composerSettingsError}
      contextUsage={contextUsage}
      density="mobile"
      draftState={draftState}
      filteredSkills={filteredSkills}
      handleTextareaKeyDown={handleTextareaKeyDown}
      isComposerBusy={isComposerBusy}
      isComposerControlsDisabled={isComposerControlsDisabled}
      isComposerDisabled={isComposerDisabled}
      isComposerDragActive={isComposerDragActive}
      models={models}
      onAttachmentInputChange={onAttachmentInputChange}
      onComposerPaste={onComposerPaste}
      onComposerSettingsChange={onComposerSettingsChange}
      onFocusComposer={() => {
        if (shouldExpandOnFocus) {
          openExpanded();
        }
      }}
      onImageOpen={onImageOpen}
      onRemovePendingAttachment={onRemovePendingAttachment}
      onStopTurn={onStopTurn}
      onSubmitTurn={onSubmitTurn}
      pendingAttachments={pendingAttachments}
      selectedThreadPresent={selectedThreadPresent}
      selectSkill={selectSkill}
      setComposerShellNode={setComposerShellNode}
      shouldShowStopAction={shouldShowStopAction}
      skillCatalog={skillCatalog}
      skillPopupOpen={skillPopupOpen}
      renderSkillSuggestions={renderSkillCommandSheet}
      textareaRef={textareaRef}
    />
  );
}

function useIsTouchDevice() {
  const [isTouchDevice, setIsTouchDevice] = useState(isTouchInputDevice);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      return;
    }

    const mediaQueries = [window.matchMedia("(any-pointer: coarse)"), window.matchMedia("(pointer: coarse)")];
    function updateTouchDevice() {
      setIsTouchDevice(isTouchInputDevice());
    }

    updateTouchDevice();
    for (const mediaQuery of mediaQueries) {
      mediaQuery.addEventListener("change", updateTouchDevice);
    }
    return () => {
      for (const mediaQuery of mediaQueries) {
        mediaQuery.removeEventListener("change", updateTouchDevice);
      }
    };
  }, []);

  return isTouchDevice;
}
