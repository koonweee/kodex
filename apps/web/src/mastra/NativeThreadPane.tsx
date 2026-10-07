import { Alert, Box, Button, Group, Loader, Modal, Stack, TextInput, Title } from '@mantine/core';
import { useEffect, useMemo, useState } from 'react';
import type { ComposerDraftStore } from '../composer/useComposerDraftState';
import { renameThread } from '../api/client';
import { TimelineView } from '../timeline/TimelineView';
import { ThreadActionsMenu } from '../panes/thread/ThreadActionsMenu';
import { useWorkspace } from '../workspace/WorkspaceProvider';
import { paneTargetRecord, type WorkspacePane } from '../workspace/paneTypes';
import { useNativeChat } from './useNativeSnapshots';
import { chatListEntry, timelinePresentation } from './presentation';
import { NativeComposer } from './NativeComposer';

export function NativeThreadPane({ pane, draftStore, onError }: { pane: WorkspacePane; draftStore: ComposerDraftStore; onError: (error: unknown) => void }) {
  const { workspace, errorMessage, setPaneThreadContext, updatePane, duplicatePane, onShowMobileSidebar, onImageOpen, onMarkdownOpen, threadActions, showDebugEvents } = useWorkspace();
  const target = paneTargetRecord(pane);
  const chatId = target.mode === 'existing' && typeof target.threadId === 'string' ? target.threadId : null;
  const { snapshot, error } = useNativeChat(chatId);
  const isActive = workspace.activePaneId === pane.id;
  const timeline = useMemo(() => snapshot ? timelinePresentation(snapshot) : null, [snapshot]);
  const [scrollParent, setScrollParent] = useState<HTMLDivElement | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [name, setName] = useState('');
  useEffect(() => {
    if (!snapshot) return;
    setPaneThreadContext(pane.id, { id: snapshot.chat.id, projectId: snapshot.chat.projectId, cwd: snapshot.chat.cwd });
    if (pane.title !== snapshot.chat.title) void updatePane(pane.id, { title: snapshot.chat.title }).catch(onError);
  }, [snapshot?.chat.id, snapshot?.chat.title, snapshot?.chat.projectId, snapshot?.chat.cwd, pane.id, pane.title, setPaneThreadContext, updatePane, onError]);
  const title = snapshot?.chat.title ?? pane.title ?? 'New thread';
  return <section className="kodex-thread-pane kodex-thread-pane-existing" data-workspace-pane-active={isActive ? "true" : undefined} data-thread-id={chatId ?? undefined} aria-label={title}>
    <Group justify="space-between" wrap="nowrap" className="kodex-thread-header">
      <Group gap="xs" wrap="nowrap"><Button className="kodex-thread-sidebar-button" onClick={onShowMobileSidebar} size="xs" variant="subtle">Threads</Button><Title className="kodex-thread-title" order={3} size="h5" title={title}>{title}</Title></Group>
      {chatId ? <ThreadActionsMenu thread={snapshot ? chatListEntry(snapshot.chat) : null} threadId={chatId}
        onDuplicatePane={() => duplicatePane(pane.id)} onRenameThread={() => { setName(title); setRenameOpen(true); }}
        onArchiveThread={threadActions.onArchiveThread} onPinThread={threadActions.onPinThread}
        onUnpinThread={threadActions.onUnpinThread} onSetThreadNotificationsEnabled={threadActions.onSetThreadNotificationsEnabled} /> : null}
    </Group>
    <Modal opened={renameOpen} onClose={() => setRenameOpen(false)} title="Rename thread"><form onSubmit={event => { event.preventDefault(); if (chatId) void renameThread(chatId, name).then(() => setRenameOpen(false)).catch(onError); }}><Stack><TextInput label="Thread name" value={name} onChange={event => setName(event.currentTarget.value)} /><Button type="submit">Rename</Button></Stack></form></Modal>
    <div className="kodex-thread-pane-status">{isActive && errorMessage ? <Alert color="red" role="alert">{errorMessage}</Alert> : null}{error || snapshot?.error ? <Alert color="red" role="alert">{error ?? snapshot?.error}</Alert> : null}</div>
    <Box className="kodex-thread-content"><div className="kodex-thread-scroll-frame"><div className="kodex-thread-pane-scroll kodex-timeline-scroll" ref={setScrollParent}>
      {chatId && !timeline ? <Loader aria-label="Loading chat" /> : timeline ? <TimelineView approvals={[]} imagePreviewUrlsByPath={{}} onApprovalDecision={() => {}} onImageOpen={onImageOpen} onMarkdownOpen={onMarkdownOpen} onReady={() => {}} scrollParentElement={scrollParent} showDebug={showDebugEvents} threadId={chatId ?? undefined} timeline={timeline} /> : null}
    </div></div></Box>
    <NativeComposer pane={pane} snapshot={snapshot} ready={!chatId || Boolean(snapshot)} isActive={isActive} draftStore={draftStore} onError={onError} />
  </section>;
}
