import { AsyncQuestionReplyProvider } from '../composer/AsyncQuestionReplyProvider';
import { mastraClient } from './client';
import { Alert, Box, Group, Loader, Title } from '@mantine/core';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { ComposerDraftStore } from '../composer/useComposerDraftState';
import { RenameThreadDialog } from '../panes/thread/RenameThreadDialog';
import { errorMessageFrom } from '../shared/values';
import { TimelineView } from '../timeline/TimelineView';
import { ThreadActionsMenu } from '../panes/thread/ThreadActionsMenu';
import { ThreadUnavailablePane } from '../panes/thread/ThreadUnavailablePane';
import { TimelineLoadingSkeleton } from '../panes/thread/TimelineLoadingSkeleton';
import { useWorkspace } from '../workspace/WorkspaceProvider';
import { paneTargetRecord, type WorkspacePane } from '../workspace/paneTypes';
import { useNativeChat } from './useNativeSnapshots';
import { useNativeCatalogSnapshot } from './NativeCatalogContext';
import { nativeUnreadCompletion, timelinePresentation } from './presentation';
import { useNativeReadState } from './useNativeReadState';
import { nativeReadWitness } from './nativeReadWitness';
import { NativeComposer } from './NativeComposer';
import { SubagentPaneToggle } from '../threads/SubagentPaneToggle';
import { threadIndicatorState } from '../threads/ThreadStatusIndicator';
import { useNativeSubagents } from './useNativeSubagents';
import { NativePromptStack } from './NativePromptStack';
import { NativeSubagentViewer } from './NativeSubagentViewer';

const submitQuestionReply = ({ threadId, text, clientId }: { threadId: string; text: string; clientId: string }) => mastraClient.replyToQuestion({ chatId: threadId, text, clientId });

export function NativeThreadPane({ pane, draftStore, onError }: { pane: WorkspacePane; draftStore: ComposerDraftStore; onError: (error: unknown) => void }) {
  const { workspace, visiblePaneIds, errorMessage, setPaneThreadContext, setPaneHeaderActions, setPaneHeaderAdornment, updatePane, duplicatePane, onImageOpen, onMarkdownOpen, onShowMobileSidebar, threadActions, showDebugEvents } = useWorkspace();
  const target = paneTargetRecord(pane);
  const chatId = target.mode === 'existing' && typeof target.threadId === 'string' ? target.threadId : null;
  const catalog = useNativeCatalogSnapshot();
  const archived = chatId !== null && Boolean(catalog?.archivedChatIds.includes(chatId));
  const { snapshot, error, retry, loadOlderHistory, isLoadingOlderHistory } = useNativeChat(archived ? null : chatId);
  useNativeReadState({ snapshot: snapshot?.chat.id === chatId && !archived ? snapshot : null, isVisible: visiblePaneIds.includes(pane.id), onRefresh: retry, onError });
  const terminalNotice = nativeReadWitness(snapshot?.chat.id === chatId ? snapshot : null).notice;
  const isUnavailable = chatId !== null && !snapshot && Boolean(error);
  const isInitialLoading = chatId !== null && !snapshot && !error && !archived;
  const subagents = useNativeSubagents(archived ? null : chatId);
  const { open: subagentsOpen, toggle: toggleSubagents } = subagents;
  const hasSubagents = Boolean(subagents.error || subagents.snapshot?.invocations.length || subagents.snapshot?.forks.length || subagents.snapshot?.children.length || subagents.snapshot?.history.hasOlder);
  const isActive = workspace.activePaneId === pane.id;
  const unreadCompletion = nativeUnreadCompletion(snapshot?.readState);
  const timeline = useMemo(() => snapshot ? timelinePresentation(snapshot, isLoadingOlderHistory) : null, [snapshot, isLoadingOlderHistory]);
  const questionItems = useMemo(() => timeline?.rows.flatMap(row => row.type === 'item' ? [row.item] : []) ?? [], [timeline]);
  const nativePrompts = useMemo(() => [
    ...(snapshot?.prompts ?? []).map(prompt => ({ prompt })), ...(subagents.snapshot?.childPrompts ?? []),
  ], [snapshot?.prompts, subagents.snapshot?.childPrompts]);
  const [scrollParent, setScrollParent] = useState<HTMLDivElement | null>(null);
  const [overflowAbove, setOverflowAbove] = useState(false);
  const [overflowBelow, setOverflowBelow] = useState(false);
  useEffect(() => { setOverflowAbove(false); setOverflowBelow(false); }, [chatId]);
  const headerAdornment = useMemo(() => isInitialLoading ? <Loader aria-hidden="true" className="kodex-thread-pane-title-spinner" size={12} /> : null, [isInitialLoading]);
  useEffect(() => {
    setPaneHeaderAdornment(pane.id, headerAdornment);
    return () => setPaneHeaderAdornment(pane.id, null);
  }, [pane.id, headerAdornment, setPaneHeaderAdornment]);
  const [renameOpen, setRenameOpen] = useState(false);
  const [name, setName] = useState('');
  const [renamePending, setRenamePending] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const renameGeneration = useRef(0);
  useEffect(() => {
    renameGeneration.current++;
    setRenameOpen(false); setRenamePending(false); setRenameError(null);
    return () => { renameGeneration.current++; };
  }, [chatId]);
  useEffect(() => {
    if (!snapshot || snapshot.chat.id !== chatId) return;
    setPaneThreadContext(pane.id, { id: snapshot.chat.id, projectId: snapshot.chat.projectId, cwd: snapshot.chat.cwd, indicatorState: threadIndicatorState({ id: snapshot.chat.id, isRunning: snapshot.display.isRunning, unreadCompletedAgentTurn: unreadCompletion }) });
    if (pane.title !== snapshot.chat.title) void updatePane(pane.id, { title: snapshot.chat.title }).catch(onError);
  }, [chatId, snapshot?.chat.id, snapshot?.chat.title, snapshot?.chat.projectId, snapshot?.chat.cwd, snapshot?.display.isRunning, unreadCompletion, pane.id, pane.title, setPaneThreadContext, updatePane, onError]);
  const title = isUnavailable ? 'Thread not found or unavailable' : snapshot?.chat.title ?? pane.title ?? 'New thread';
  const nativeChatId = snapshot?.chat.id;
  const nativeName = snapshot?.chat.name;
  const nativeProjectId = snapshot?.chat.projectId;
  const pinned = snapshot?.chat.pinned;
  const notificationsEnabled = snapshot?.chat.notificationsEnabled;
  const menuThread = useMemo(() => nativeChatId ? { id: nativeChatId, name: title, projectId: nativeProjectId ?? null, pinned, notificationsEnabled } : null, [nativeChatId, nativeProjectId, title, pinned, notificationsEnabled]);
  const handleDuplicatePane = useCallback(() => duplicatePane(pane.id), [duplicatePane, pane.id]);
  const handleRename = useCallback(() => { setName(nativeName ?? ''); setRenameError(null); setRenameOpen(true); }, [nativeName]);
  const { onArchiveThread, onPinThread, onUnpinThread, onSetThreadNotificationsEnabled, pinPending } = threadActions;
  // Only header inputs belong here; live message snapshots must not re-register chrome.
  const paneHeaderActions = useMemo(() => chatId && !isUnavailable ? (
    <Group className="kodex-thread-pane-actions" gap={4} wrap="nowrap">
      <SubagentPaneToggle visible={hasSubagents} open={subagentsOpen} onToggle={toggleSubagents} />
      <ThreadActionsMenu thread={menuThread} threadId={chatId} pinPending={pinPending}
        onDuplicatePane={handleDuplicatePane} onRenameThread={handleRename}
        onArchiveThread={onArchiveThread} onPinThread={onPinThread}
        onUnpinThread={onUnpinThread} onSetThreadNotificationsEnabled={onSetThreadNotificationsEnabled} />
    </Group>
  ) : null, [chatId, isUnavailable, menuThread, handleDuplicatePane, handleRename, onArchiveThread, onPinThread, onUnpinThread, onSetThreadNotificationsEnabled, pinPending, hasSubagents, subagentsOpen, toggleSubagents]);
  useEffect(() => {
    setPaneHeaderActions(pane.id, paneHeaderActions);
    return () => setPaneHeaderActions(pane.id, null);
  }, [pane.id, paneHeaderActions, setPaneHeaderActions]);
  function closeRename() { if (!renamePending) { setRenameOpen(false); setRenameError(null); } }
  async function submitRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!chatId || renamePending) return;
    const title = name.trim();
    if (!title) { setRenameError('Thread name cannot be empty.'); return; }
    if (!threadActions.onRenameThread) { setRenameError('Renaming is unavailable.'); return; }
    const generation = renameGeneration.current;
    setRenamePending(true); setRenameError(null);
    try {
      await threadActions.onRenameThread(chatId, title);
      // Canonical watches own the saved title, including changes from other tabs.
      if (renameGeneration.current === generation) setRenameOpen(false);
    } catch (failure) {
      if (renameGeneration.current === generation) setRenameError(errorMessageFrom(failure));
    } finally {
      if (renameGeneration.current === generation) setRenamePending(false);
    }
  }
  return <section className="kodex-thread-pane kodex-thread-pane-existing" data-workspace-pane-active={isActive ? "true" : undefined} data-thread-id={chatId ?? undefined} aria-label={title}>
    <Title className="kodex-thread-pane-accessible-title" order={3} size="h5" title={title}>{title}</Title>
    <RenameThreadDialog opened={renameOpen && Boolean(nativeChatId)} title={title} name={name} pending={renamePending}
      error={renameError} onClose={closeRename} onSubmit={submitRename}
      onChange={value => { setName(value); if (renameError) setRenameError(null); }} />
    {!isUnavailable && <div className="kodex-thread-pane-status">{isActive && errorMessage ? <Alert color="red" role="alert">{errorMessage}</Alert> : null}{subagents.error ? <Alert color="red" role="alert">{subagents.error}</Alert> : null}{error ? <Alert color="red" role="alert">{error}</Alert> : null}{snapshot?.error && terminalNotice?.reason !== 'error' ? <Alert color="red" role="alert">{snapshot.error}</Alert> : null}{terminalNotice ? <Alert color={terminalNotice.reason === 'error' ? 'red' : 'gray'} role="alert">{terminalNotice.text}</Alert> : null}</div>}
    {isUnavailable ? <ThreadUnavailablePane paneId={pane.id} onBrowseThreads={onShowMobileSidebar} /> : <Box className="kodex-thread-content" data-subagent-sidebar={subagentsOpen ? "open" : "closed"}><div className="kodex-thread-scroll-frame" data-overflow-above={overflowAbove ? "true" : undefined} data-overflow-below={overflowBelow ? "true" : undefined}><div className="kodex-thread-pane-scroll kodex-timeline-scroll" ref={setScrollParent}>
      {isInitialLoading ? <TimelineLoadingSkeleton /> : timeline ? <AsyncQuestionReplyProvider key={chatId} threadId={chatId!} enabled={!archived} items={questionItems} submitReply={submitQuestionReply}><TimelineView approvals={[]} imagePreviewUrlsByPath={{}} onApprovalDecision={() => {}} onImageOpen={onImageOpen} onLoadOlderHistory={loadOlderHistory} onMarkdownOpen={onMarkdownOpen} onOverflowAboveChange={setOverflowAbove} onOverflowBelowChange={setOverflowBelow} onReady={() => {}} scrollParentElement={scrollParent} showDebug={showDebugEvents} threadId={chatId ?? undefined} timeline={timeline} /></AsyncQuestionReplyProvider> : null}
      {chatId && nativePrompts.length ? <NativePromptStack prompts={nativePrompts} onRefresh={() => { retry(); subagents.retry(); }} onRespond={response => mastraClient.respondPrompt({ chatId, ...response })} /> : null}
    </div></div>
      {subagentsOpen && chatId ? <NativeSubagentViewer chatId={chatId} inventory={subagents.snapshot} selectedId={subagents.selectedId} onSelect={subagents.select}
        error={subagents.error} onReload={subagents.retry} loadingMore={subagents.isLoadingOlderHistory} onLoadMore={subagents.loadOlderHistory}
        onImageOpen={onImageOpen} onMarkdownOpen={onMarkdownOpen} showDebug={showDebugEvents} /> : null}
    </Box>}
    {!isUnavailable && <NativeComposer pane={pane} snapshot={snapshot} ready={!chatId || Boolean(snapshot)} isActive={isActive} draftStore={draftStore} onError={onError} onQueueReload={retry} />}
  </section>;
}
