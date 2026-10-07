import { Box, Group, Menu, Textarea } from "@mantine/core";
import { ChevronDown, Folder, MessageSquare } from "lucide-react";
import { useId } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from "react";

import type { SkillMetadata } from "../api/client";
import { AttachmentTray } from "./AttachmentTray";
import { ComposerAnnotations } from "./ComposerAnnotations";
import type { ComposerPanelProps } from "./ComposerPanel";
import { GoalBar, type GoalControls } from "../goals/GoalControls";
import { useCompactComposer } from "./useCompactComposer";
import { ComposerToolbar } from "./ComposerToolbar";
import { SlashCommandPopup } from "./SlashCommandPopup";
import { SkillMentionPopup } from "./SkillMentionPopup";
import { shouldSyncComposerCursorOnKeyUp } from "./keyEvents";
import type { SlashCommandItem } from "./slashCommands";
import type { ComposerDraftState } from "./useComposerDraftState";
import type { SkillCatalogState } from "./useSkillCatalog";

const COMPOSER_TEXT = {
  addAttachment: "Add attachment",
  disabledPlaceholder: "Select a thread to start composing",
  dropImages: "Drop images to attach",
  placeholder: "type clever thing here",
  projectSelector: "Project",
  noProject: "No project",
};

type InlineComposerPanelProps = ComposerPanelProps & {
  goalControls?: GoalControls;
  queuePanel?: ReactNode;
  queueOnSubmit?: boolean;
  canSubmitComposer: boolean;
  density?: "desktop" | "mobile";
  expanded?: { header: ReactNode; style: CSSProperties };
  draftState: ComposerDraftState;
  filteredSkills: SkillMetadata[];
  filteredSlashCommands: SlashCommandItem[];
  handleTextareaKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
  isComposerBusy: boolean;
  isComposerControlsDisabled: boolean;
  isComposerDisabled: boolean;
  isEntryPending: boolean;
  onExpandComposer?: () => void;
  onFocusComposer?: () => void;
  renderSkillSuggestions?: () => ReactNode;
  selectSkill: (skillIndex?: number) => void;
  selectSlashCommand: (commandIndex?: number) => void;
  setComposerShellNode: (node: HTMLDivElement | null) => void;
  shouldShowStopAction: boolean;
  skillCatalog: SkillCatalogState;
  skillPopupOpen: boolean;
  slashPopupOpen: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
};

export function InlineComposerPanel({
  attachmentInputRef,
  canCompose,
  canSubmitComposer,
  composerSettings,
  composerSettingsDisabled,
  composerSettingsError,
  contextUsage,
  currentProjectName,
  density = "desktop",
  expanded,
  draftProjectSelector,
  draftState,
  goalControls,
  filteredSkills,
  filteredSlashCommands,
  handleTextareaKeyDown,
  isDraftThreadSelected,
  isDraftComposerTransitioning,
  isComposerBusy,
  isComposerControlsDisabled,
  isComposerDisabled,
  isComposerDragActive,
  isComposerSubmitting,
  isEntryPending,
  models,
  onAttachmentInputChange,
  onComposerDragLeave,
  onComposerDragOver,
  onComposerDrop,
  onComposerKeyDown,
  onComposerPaste,
  onComposerSettingsChange,
  onExpandComposer,
  onFocusComposer,
  onImageOpen,
  onRemovePendingAttachment,
  onStopTurn,
  onSubmitTurn,
  pendingAttachments,
  queuePanel,
  queueOnSubmit,
  selectedThreadPresent,
  selectSkill,
  selectSlashCommand,
  setComposerShellNode,
  shouldShowStopAction,
  skillCatalog,
  skillPopupOpen,
  slashPopupOpen,
  renderSkillSuggestions,
  textareaRef,
}: InlineComposerPanelProps) {
  const formId = useId();
  const draftHeroText = greetingForDate(new Date());
  const shouldShowDraftHero = !expanded && (isDraftThreadSelected || isDraftComposerTransitioning);
  const compactComposer = useCompactComposer(textareaRef);
  const selectedDraftProject =
    draftProjectSelector?.projects.find((project) => project.id === draftProjectSelector.value) ?? null;
  const draftProjectSelectorLabel = selectedDraftProject?.name ?? COMPOSER_TEXT.noProject;
  const draftProjectToolbarName =
    isDraftThreadSelected && !draftProjectSelector && currentProjectName ? currentProjectName : null;
  const hasUnderbar = isDraftThreadSelected && (draftProjectSelector !== undefined || Boolean(draftProjectToolbarName));

  return (
    <Box
      ref={setComposerShellNode}
      className={`kodex-composer-shell kodex-thread-column${expanded ? " kodex-mobile-composer-expanded" : ""}`}
      role={expanded ? "dialog" : undefined}
      aria-label={expanded ? "Compose" : undefined}
      style={expanded?.style}
      data-inline-density={density}
      data-entry-ready={isEntryPending ? "false" : "true"}
      data-drag-active={isComposerDragActive ? "true" : "false"}
      onDragLeave={isComposerControlsDisabled ? undefined : onComposerDragLeave}
      onDragOver={isComposerControlsDisabled ? undefined : onComposerDragOver}
      onDrop={isComposerControlsDisabled ? undefined : onComposerDrop}
    >
      {expanded?.header}
      {shouldShowDraftHero ? (
        <Box
          className="kodex-composer-hero-stage"
          data-transitioning={isDraftComposerTransitioning ? "true" : "false"}
        >
          <Box className="kodex-composer-hero">{draftHeroText}</Box>
        </Box>
      ) : null}
      {goalControls && !goalControls.compact ? <GoalBar controls={goalControls} /> : null}
      {expanded ? null : queuePanel}
      <Box
        component="form"
        id={formId}
        className={`kodex-composer${expanded ? " kodex-mobile-composer-expanded-body" : ""}`}
        data-skill-command-open={expanded && (skillPopupOpen || slashPopupOpen) ? "true" : undefined}
        onSubmit={(event) =>
          onSubmitTurn(
            event,
            draftState.currentSubmittedText(),
            draftState.captureSubmission(),
            draftState.currentSkillInputs(),
            draftState.currentSkillTextElements(),
            draftState.currentTimelineSkillMentions(),
          )
        }
      >
        {selectedThreadPresent ? <button type="submit" hidden data-submit-intent="queue" disabled={!canSubmitComposer} /> : null}
        {skillPopupOpen || slashPopupOpen ? (
          renderSkillSuggestions ? renderSkillSuggestions() : skillPopupOpen ? (
            <SkillMentionPopup
              activeIndex={draftState.activeSkillIndex}
              error={skillCatalog.error}
              loading={skillCatalog.loading}
              skills={filteredSkills}
              onSelect={(skill) => selectSkill(filteredSkills.findIndex((item) => item.path === skill.path))}
            />
          ) : (
            <SlashCommandPopup
              activeIndex={draftState.activeSlashIndex}
              commands={filteredSlashCommands}
              onSelect={(command) =>
                selectSlashCommand(filteredSlashCommands.findIndex((item) => item.id === command.id))
              }
            />
          )
        ) : null}
        <input
          ref={attachmentInputRef}
          aria-label={COMPOSER_TEXT.addAttachment}
          className="kodex-attachment-input"
          type="file"
          multiple
          disabled={isComposerControlsDisabled}
          onChange={onAttachmentInputChange}
        />
        {pendingAttachments.length > 0 && !isComposerBusy ? (
          <AttachmentTray
            compact={Boolean(expanded)}
            attachments={pendingAttachments}
            onImageOpen={onImageOpen}
            onRemove={onRemovePendingAttachment}
          />
        ) : null}
        <ComposerAnnotations draftState={draftState} disabled={isComposerControlsDisabled}
          collapseByDefault={density === "mobile"} onFocus={onFocusComposer} onKeyDown={onComposerKeyDown} />
        <Textarea
          ref={textareaRef}
          aria-label="Message composer"
          className={`kodex-composer-textarea${expanded ? " kodex-mobile-composer-textarea" : ""}`}
          placeholder={canCompose ? COMPOSER_TEXT.placeholder : COMPOSER_TEXT.disabledPlaceholder}
          minRows={expanded ? 3 : density === "mobile" || compactComposer ? 2 : 4}
          maxRows={expanded ? 16 : compactComposer ? 5 : 10}
          autosize
          value={draftState.composerText}
          onChange={(event) => {
            if (!isComposerDisabled) {
              draftState.updateComposerText(event.currentTarget.value, event.currentTarget.selectionStart);
            }
          }}
          onClick={(event) => draftState.updateComposerText(event.currentTarget.value, event.currentTarget.selectionStart)}
          onFocus={() => {
            if (!isComposerDisabled) {
              onFocusComposer?.();
            }
          }}
          onKeyUp={(event) => {
            if (shouldSyncComposerCursorOnKeyUp(event.key)) {
              draftState.updateComposerText(event.currentTarget.value, event.currentTarget.selectionStart);
            }
          }}
          onKeyDown={isComposerControlsDisabled ? undefined : handleTextareaKeyDown}
          onPaste={isComposerControlsDisabled ? undefined : onComposerPaste}
          disabled={isComposerDisabled}
          variant="unstyled"
        />
        {isComposerDragActive ? (
          <Box className="kodex-composer-drop-hint" aria-hidden="true">
            {COMPOSER_TEXT.dropImages}
          </Box>
        ) : null}
        {expanded && (skillPopupOpen || slashPopupOpen) ? null : (
          <ComposerToolbar
            queueOnSubmit={queueOnSubmit}
            goalControls={goalControls}
            formId={formId}
            attachmentInputRef={attachmentInputRef}
            canSubmitComposer={canSubmitComposer}
            contextUsage={contextUsage}
            disabled={isComposerControlsDisabled}
            models={models}
            onExpandComposer={onExpandComposer}
            onSettingsChange={onComposerSettingsChange}
            onStopTurn={onStopTurn}
            selectedThreadPresent={selectedThreadPresent}
            settings={composerSettings}
            settingsDisabled={composerSettingsDisabled}
            settingsError={composerSettingsError}
            shouldShowStopAction={shouldShowStopAction}
            isSubmitting={isComposerSubmitting}
            showContextUsage={!shouldShowDraftHero}
          />
        )}
      </Box>
      {hasUnderbar && !expanded ? (
        <Box className="kodex-composer-underbar" aria-label="Draft thread toolbar" role="toolbar">
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
            {draftProjectToolbarName ? (
              <Group className="kodex-composer-underbar-item" gap={8} wrap="nowrap">
                <Folder size={15} />
                <span title={draftProjectToolbarName}>{draftProjectToolbarName}</span>
              </Group>
            ) : null}
          </Group>
        </Box>
      ) : null}
    </Box>
  );
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
