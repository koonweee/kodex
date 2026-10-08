import { Alert, Box, Group, Loader, Title } from '@mantine/core';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { ComposerDraftStore } from '../composer/useComposerDraftState';
import { RenameThreadDialog } from '../panes/thread/RenameThreadDialog';
import { errorMessageFrom } from '../shared/values';
import { TimelineView } from '../timeline/TimelineView';
import { ThreadActionsMenu } from '../panes/thread/ThreadActionsMenu';
import { useWorkspace } from '../workspace/WorkspaceProvider';
import { paneTargetRecord, type WorkspacePane } from '../workspace/paneTypes';
import { useNativeChat } from './useNativeSnapshots';
import { useNativeCatalogSnapshot } from './NativeCatalogContext';
import { timelinePresentation } from './presentation';
import { NativeComposer } from './NativeComposer';

export function NativeThreadPane({ pane, draftStore, onError }: { pane: WorkspacePane; draftStore: ComposerDraftStore; onError: (error: unknown) => void }) {
  const { workspace, errorMessage, setPaneThreadContext, setPaneHeaderActions, updatePane, duplicatePane, onImageOpen, onMarkdownOpen, threadActions, showDebugEvents } = useWorkspace();
  const target = paneTargetRecord(pane);
  const chatId = target.mode === 'existing' && typeof target.threadId === 'string' ? target.threadId : null;
  const catalog = useNativeCatalogSnapshot();
  const archived = chatId !== null && Boolean(catalog?.archivedChatIds.includes(chatId));
  const { snapshot, error, retry, loadOlderHistory, isLoadingOlderHistory } = useNativeChat(archived ? null : chatId);
  const isActive = workspace.activePaneId === pane.id;
  const timeline = useMemo(() => snapshot ? timelinePresentation(snapshot, isLoadingOlderHistory) : null, [snapshot, isLoadingOlderHistory]);
  const [scrollParent, setScrollParent] = useState<HTMLDivElement | null>(null);
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
    if (!snapshot) return;
    setPaneThreadContext(pane.id, { id: snapshot.chat.id, projectId: snapshot.chat.projectId, cwd: snapshot.chat.cwd });
    if (pane.title !== snapshot.chat.title) void updatePane(pane.id, { title: snapshot.chat.title }).catch(onError);
  }, [snapshot?.chat.id, snapshot?.chat.title, snapshot?.chat.projectId, snapshot?.chat.cwd, pane.id, pane.title, setPaneThreadContext, updatePane, onError]);
  const title = snapshot?.chat.title ?? pane.title ?? 'New thread';
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
  const paneHeaderActions = useMemo(() => chatId ? (
    <Group className="kodex-thread-pane-actions" gap={4} wrap="nowrap">
      <ThreadActionsMenu thread={menuThread} threadId={chatId} pinPending={pinPending}
        onDuplicatePane={handleDuplicatePane} onRenameThread={handleRename}
        onArchiveThread={onArchiveThread} onPinThread={onPinThread}
        onUnpinThread={onUnpinThread} onSetThreadNotificationsEnabled={onSetThreadNotificationsEnabled} />
    </Group>
  ) : null, [chatId, menuThread, handleDuplicatePane, handleRename, onArchiveThread, onPinThread, onUnpinThread, onSetThreadNotificationsEnabled, pinPending]);
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
    <div className="kodex-thread-pane-status">{isActive && errorMessage ? <Alert color="red" role="alert">{errorMessage}</Alert> : null}{error || snapshot?.error ? <Alert color="red" role="alert">{error ?? snapshot?.error}</Alert> : null}</div>
    <Box className="kodex-thread-content"><div className="kodex-thread-scroll-frame"><div className="kodex-thread-pane-scroll kodex-timeline-scroll" ref={setScrollParent}>
      {chatId && !timeline ? <Loader aria-label="Loading chat" /> : timeline ? <TimelineView approvals={[]} imagePreviewUrlsByPath={{}} onApprovalDecision={() => {}} onImageOpen={onImageOpen} onLoadOlderHistory={loadOlderHistory} onMarkdownOpen={onMarkdownOpen} onReady={() => {}} scrollParentElement={scrollParent} showDebug={showDebugEvents} threadId={chatId ?? undefined} timeline={timeline} /> : null}
    </div></div></Box>
    <NativeComposer pane={pane} snapshot={snapshot} ready={!chatId || Boolean(snapshot)} isActive={isActive} draftStore={draftStore} onError={onError} onQueueReload={retry} />
  </section>;
}
