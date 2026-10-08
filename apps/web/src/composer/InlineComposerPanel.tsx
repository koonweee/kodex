import { Box, Group, Menu, Textarea } from "@mantine/core";
import { ChevronDown, Folder, MessageSquare } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject, PointerEventHandler } from "react";

import type { SkillMetadata } from "../api/client";
import { AttachmentTray } from "./AttachmentTray";
import { ComposerAnnotations } from "./ComposerAnnotations";
import type { ComposerPanelProps } from "./ComposerPanel";
import { GoalBar, type GoalControls } from "../goals/GoalControls";
import { ComposerToolbar } from "./ComposerToolbar";
import { SlashCommandPopup } from "./SlashCommandPopup";
import { SkillMentionPopup } from "./SkillMentionPopup";
import { shouldSyncComposerCursorOnKeyUp } from "./keyEvents";
import type { SlashCommandItem } from "./slashCommands";
import type { ComposerDraftState } from "./useComposerDraftState";
import type { SkillCatalogState } from "./useSkillCatalog";
import { useInlineComposerMotion } from "./useInlineComposerMotion";

const COMPOSER_TEXT = {
  addAttachment: "Add attachment",
  disabledPlaceholder: "Select a thread to start composing",
  dropImages: "Drop images to attach",
  placeholder: "type clever thing here",
  compactPlaceholder: "build thing",
  projectSelector: "Project",
  noProject: "No project",
};

type InlineComposerPanelProps = ComposerPanelProps & {
  goalControls?: GoalControls;
  queuePanel?: ReactNode;
  queueOnSubmit?: boolean;
  canSubmitComposer: boolean;
  density?: "regular" | "compact";
  expanded?: { header: ReactNode; style: CSSProperties };
  draftState: ComposerDraftState;
  filteredSkills: SkillMetadata[];
  filteredSlashCommands: SlashCommandItem[];
  handleTextareaKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
  isComposerBusy: boolean;
  isComposerControlsDisabled: boolean;
  isComposerDisabled: boolean;
  isEntryPending: boolean;
  onEditablePointerDown?: PointerEventHandler<HTMLTextAreaElement>;
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
  density = "regular",
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
  onEditablePointerDown,
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
  const formRef = useRef<HTMLFormElement>(null);
  const [editingActive, setEditingActive] = useState(false);
  const [composerFocused, setComposerFocused] = useState(false);
  const [toolbarMenuOpen, setToolbarMenuOpen] = useState(false);
  const focusRevision = useRef(0);
  useEffect(() => () => { focusRevision.current += 1; }, []);
  useEffect(() => {
    if (composerFocused || toolbarMenuOpen) return;
    // Let focus and menu state settle before ending the editing session.
    const frame = requestAnimationFrame(() => setEditingActive(false));
    return () => cancelAnimationFrame(frame);
  }, [composerFocused, toolbarMenuOpen]);
  // Keep the empty row stable through attachment and settings loading.
  const idleCompact = density === "compact" && selectedThreadPresent && !isDraftThreadSelected &&
    !isDraftComposerTransitioning && !expanded && !editingActive &&
    draftState.composerText.length === 0 && draftState.annotations.length === 0 &&
    draftState.skillBindings.length === 0 && pendingAttachments.length === 0 &&
    !skillPopupOpen && !slashPopupOpen && !isComposerDragActive && !isComposerBusy && !composerSettingsError;
  const inlineMotion = density === "compact" && selectedThreadPresent && !isDraftThreadSelected && !isDraftComposerTransitioning && !expanded;
  useInlineComposerMotion(formRef, inlineMotion, idleCompact);
  const draftHeroText = greetingForDate(new Date());
  const shouldShowDraftHero = !expanded && (isDraftThreadSelected || isDraftComposerTransitioning);
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
        ref={formRef}
        id={formId}
        className={`kodex-composer${expanded ? " kodex-mobile-composer-expanded-body" : ""}`}
        data-idle-compact={idleCompact ? "true" : "false"}
        data-inline-motion={inlineMotion ? "true" : undefined}
        onFocusCapture={(event) => {
          focusRevision.current += 1;
          // Footer controls alone do not move under a pointer opening their menu.
          setComposerFocused(true);
          if ((event.target as HTMLElement) === textareaRef.current) setEditingActive(true);
        }}
        onBlurCapture={() => {
          const revision = ++focusRevision.current;
          // React focus events include portalled menus. Wait for the next focus
          // before ending editing, rather than using DOM containment across portals.
          queueMicrotask(() => {
            if (focusRevision.current === revision) setComposerFocused(false);
          });
        }}
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
        {inlineMotion ? <Box className="kodex-composer-surface" aria-hidden="true" /> : null}
        {selectedThreadPresent ? <button type="submit" hidden data-submit-intent="queue" disabled={!canSubmitComposer} /> : null}
        <button type="submit" hidden data-submit-intent="alternate" disabled={!canSubmitComposer} />
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
            compact={density === "compact" || Boolean(expanded)}
            attachments={pendingAttachments}
            onImageOpen={onImageOpen}
            onRemove={onRemovePendingAttachment}
          />
        ) : null}
        <ComposerAnnotations draftState={draftState} disabled={isComposerControlsDisabled}
          collapseByDefault={density === "compact"} onPointerDown={onEditablePointerDown} onKeyDown={onComposerKeyDown} />
        <Textarea
          ref={textareaRef}
          aria-label="Message composer"
          className={`kodex-composer-textarea${expanded ? " kodex-mobile-composer-textarea" : ""}`}
          placeholder={canCompose ? (idleCompact ? COMPOSER_TEXT.compactPlaceholder : COMPOSER_TEXT.placeholder) : COMPOSER_TEXT.disabledPlaceholder}
          minRows={expanded ? 3 : idleCompact ? 1 : 2}
          maxRows={expanded ? 16 : idleCompact ? 1 : 5}
          autosize
          value={draftState.composerText}
          onChange={(event) => {
            if (!isComposerDisabled) {
              draftState.updateComposerText(event.currentTarget.value, event.currentTarget.selectionStart);
            }
          }}
          onClick={(event) => draftState.updateComposerText(event.currentTarget.value, event.currentTarget.selectionStart)}
          onPointerDown={isComposerDisabled ? undefined : onEditablePointerDown}
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
            onMenuOpenChange={setToolbarMenuOpen}
            queueOnSubmit={queueOnSubmit}
            goalControls={goalControls}
            formId={formId}
            attachmentInputRef={attachmentInputRef}
            canSubmitComposer={canSubmitComposer}
            contextUsage={contextUsage}
            disabled={isComposerControlsDisabled}
            models={models}
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
