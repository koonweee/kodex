import { Box, Group, Menu, Textarea } from "@mantine/core";
import { ChevronDown, Folder, GitGraph, MessageSquare } from "lucide-react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from "react";

import type { SkillMetadata } from "../api/client";
import { AttachmentTray } from "./AttachmentTray";
import type { ComposerPanelProps } from "./ComposerPanel";
import { ComposerToolbar } from "./ComposerToolbar";
import { QueuedSteerCard } from "./QueuedSteerCard";
import { SkillMentionPopup } from "./SkillMentionPopup";
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
  canSubmitComposer: boolean;
  density?: "desktop" | "mobile";
  draftState: ComposerDraftState;
  filteredSkills: SkillMetadata[];
  handleTextareaKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
  isComposerBusy: boolean;
  isComposerControlsDisabled: boolean;
  isComposerDisabled: boolean;
  isEntryPending: boolean;
  onExpandComposer?: () => void;
  onFocusComposer?: () => void;
  renderSkillSuggestions?: () => ReactNode;
  selectSkill: (skillIndex?: number) => void;
  setComposerShellNode: (node: HTMLDivElement | null) => void;
  shouldShowStopAction: boolean;
  skillCatalog: SkillCatalogState;
  skillPopupOpen: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
};

export function InlineComposerPanel({
  activeSelectedTurnId,
  attachmentInputRef,
  canCompose,
  canSubmitComposer,
  composerSettings,
  composerSettingsError,
  contextUsage,
  currentProjectName,
  density = "desktop",
  draftProjectSelector,
  draftState,
  filteredSkills,
  handleTextareaKeyDown,
  isDraftThreadSelected,
  isDraftComposerTransitioning,
  isComposerBusy,
  isComposerControlsDisabled,
  isComposerDisabled,
  isComposerDragActive,
  isQueuedTurnStartPending,
  isEntryPending,
  models,
  onAbortQueuedSteer,
  onAttachmentInputChange,
  onComposerDragLeave,
  onComposerDragOver,
  onComposerDrop,
  onComposerPaste,
  onComposerSettingsChange,
  onExpandComposer,
  onFocusComposer,
  onImageOpen,
  onRemovePendingAttachment,
  onStopTurn,
  onSubmitQueuedSteer,
  onSubmitTurn,
  pendingAttachments,
  queuedSteerRows,
  selectedGitBranch,
  selectedThreadPresent,
  selectSkill,
  setComposerShellNode,
  shouldShowStopAction,
  skillCatalog,
  skillPopupOpen,
  renderSkillSuggestions,
  textareaRef,
}: InlineComposerPanelProps) {
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

  return (
    <Box
      ref={setComposerShellNode}
      className="kodex-composer-shell kodex-main-column"
      data-inline-density={density}
      data-entry-ready={isEntryPending ? "false" : "true"}
      data-drag-active={isComposerDragActive ? "true" : "false"}
      onDragLeave={isComposerControlsDisabled ? undefined : onComposerDragLeave}
      onDragOver={isComposerControlsDisabled ? undefined : onComposerDragOver}
      onDrop={isComposerControlsDisabled ? undefined : onComposerDrop}
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
          blockIdleStartActions={activeSelectedTurnId === null && (Boolean(isQueuedTurnStartPending) || isComposerControlsDisabled)}
          hasActiveTurn={activeSelectedTurnId !== null}
          rows={queuedSteerRows}
          onAbortRow={onAbortQueuedSteer}
          onSubmitRow={onSubmitQueuedSteer}
        />
      ) : null}
      <Box
        component="form"
        className="kodex-composer"
        onSubmit={(event) =>
          onSubmitTurn(
            event,
            draftState.currentSubmittedText(),
            {
              clearText: draftState.clearText,
              restoreText: draftState.restoreText,
            },
            draftState.currentSkillInputs(),
            draftState.currentSkillTextElements(),
            draftState.currentTimelineSkillMentions(),
          )
        }
      >
        {skillPopupOpen ? (
          renderSkillSuggestions ? renderSkillSuggestions() : (
            <SkillMentionPopup
              activeIndex={draftState.activeSkillIndex}
              error={skillCatalog.error}
              loading={skillCatalog.loading}
              skills={filteredSkills}
              onSelect={(skill) => selectSkill(filteredSkills.findIndex((item) => item.path === skill.path))}
            />
          )
        ) : null}
        <input
          ref={attachmentInputRef}
          aria-label={COMPOSER_TEXT.addAttachment}
          className="kodex-attachment-input"
          type="file"
          accept="image/*"
          multiple
          disabled={isComposerControlsDisabled}
          onChange={onAttachmentInputChange}
        />
        {pendingAttachments.length > 0 && !isComposerBusy ? (
          <AttachmentTray attachments={pendingAttachments} onImageOpen={onImageOpen} onRemove={onRemovePendingAttachment} />
        ) : null}
        <Textarea
          ref={textareaRef}
          aria-label="Message composer"
          className="kodex-composer-textarea"
          placeholder={canCompose ? COMPOSER_TEXT.placeholder : COMPOSER_TEXT.disabledPlaceholder}
          minRows={2}
          maxRows={10}
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
            if (event.key !== "Escape") {
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
        <ComposerToolbar
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
          settingsError={composerSettingsError}
          shouldShowStopAction={shouldShowStopAction}
          showContextUsage={!shouldShowDraftHero}
        />
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
