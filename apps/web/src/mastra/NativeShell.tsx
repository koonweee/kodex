import { Alert, Group } from '@mantine/core';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNarrowThreadWorkspace } from '../shell/KodexShellView';
import { currentKodexRoute, pushKodexRoute, replaceKodexRoute } from '../shell/browserRouting';
import { useSidebarResize } from '../shell/useSidebarResize';
import type { AppearancePreferences } from '../theme/appearancePreferences';
import type { KodexColorSchemeId } from '../theme';
import type { WorkspacePaneStoreAdapter } from '../workspace/paneStore';
import { WorkspaceProvider } from '../workspace/WorkspaceProvider';
import type { ComposerDraftStore } from '../composer/useComposerDraftState';
import type { MarkdownPreviewRequest } from '../files/types';
import type { ImageLightboxImage } from '../images/types';
import type { PreferenceSection } from '../PreferencesModal';
import { WorkspaceProjectCreateDialog } from '../projects/ProjectCreateDialog';
import { errorMessageFrom } from '../shared/values';
import { useNativeHost } from './NativeHostBoundary';
import { useNativeCatalog } from './useNativeSnapshots';
import { chatListEntry } from './presentation';
import { NativeArchiveReconciliation } from './NativeArchiveReconciliation';
import { NativeThreadPane } from './NativeThreadPane';
import { NativeAccountMenu } from './NativeAccountMenu';
import { NativeMcpPreferencesPanel } from './NativeMcpPreferencesPanel';
import { NativeExecutionPreferencesPanel } from './NativeExecutionPreferencesPanel';
import { useNativeAccount } from './useNativeAccount';
import { useNativeChatMetadata } from './useNativeChatMetadata';
import { mastraClient } from './client';
import { nativeTerminalApi } from './nativeTerminalApi';
import { useNativeAutomations } from './useNativeAutomations';
import { NativeAutomationRuns } from './NativeAutomationRuns';
import { NativeCatalogProvider } from './NativeCatalogContext';
import { NativeWorkspaceShellView } from './NativeWorkspaceShellView';
import type { DirectoryLoader, ProjectCreationFields, ProjectFormPatch } from '../projects/controls';

const MarkdownPreviewPane = lazy(() => import('../files/MarkdownPreviewPane').then(module => ({ default: module.MarkdownPreviewPane })));
const ImageLightbox = lazy(() => import('../images/ImageLightbox').then(module => ({ default: module.ImageLightbox })));
export type NativeShellProps = {
  colorSchemeId: KodexColorSchemeId; appearance: AppearancePreferences;
  onAppearanceModeChange: (mode: AppearancePreferences['mode']) => void;
  onThemeChange: (id: KodexColorSchemeId) => void; workspacePaneStore?: WorkspacePaneStoreAdapter;
};
export function NativeShell({ colorSchemeId, appearance, onAppearanceModeChange, onThemeChange, workspacePaneStore }: NativeShellProps) {
  const info = useNativeHost();
  const catalog = useNativeCatalog();
  const [route, setRoute] = useState(currentKodexRoute);
  // A URL requests a pane once. Workspace focus reports must not seed another
  // pane, especially when persisted focus differs from a tab's deep link.
  const [routeThreadPaneId, setRouteThreadPaneId] = useState(route.threadId);
  const [mobilePanel, setMobilePanel] = useState<'threads' | 'chat'>(route.panel ?? 'chat');
  const [error, setError] = useState<string | null>(null);
  const [hoveredThreadActionId, setHoveredThreadActionId] = useState<string | null>(null);
  const [showDebugEvents, setShowDebugEvents] = useState(false);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [preferencesSection, setPreferencesSection] = useState<PreferenceSection>('appearance');
  const [projectFormOpen, setProjectFormOpen] = useState(false);
  const [markdownPreview, setMarkdownPreview] = useState<MarkdownPreviewRequest | null>(null);
  const [lightbox, setLightbox] = useState<ImageLightboxImage | null>(null);
  const drafts = useRef<ComposerDraftStore>(new Map());
  const emptyPendingTitles = useMemo(() => new Set<string>(), []);
  const resize = useSidebarResize();
  const singlePane = useNarrowThreadWorkspace();
  const mainPane = route.view ?? 'thread';
  const reportError = useCallback((failure: unknown) => setError(errorMessageFrom(failure)), []);
  const perform = useCallback((operation: Promise<unknown>) => { void operation.catch(reportError); }, [reportError]);
  const account = useNativeAccount();
  const metadata = useNativeChatMetadata(catalog.snapshot?.epoch ?? null, reportError);
  const automations = useNativeAutomations(mainPane === 'automations');
  const projects = useMemo(() => (catalog.snapshot?.projects ?? []).map(project => ({ id: project.id, name: project.name, roots: project.roots.map(path => ({ path })) })), [catalog.snapshot?.projects]);
  const chats = catalog.snapshot?.chats ?? [];
  const entries = chats.map(chatListEntry);
  // Pinned descendants supply row/route metadata without joining ordinary
  // project/chat inventory or automation target options.
  const chatsById = new Map([...chats, ...(catalog.snapshot?.pinnedDescendants ?? [])].map(chat => [chat.id, chat]));
  const pinned = (catalog.snapshot?.pinnedChatIds ?? []).flatMap(id => {
    const chat = chatsById.get(id);
    if (!chat) return [];
    return [chatListEntry(chat)];
  });
  const threadsByProjectId = Object.fromEntries(projects.map(project => [project.id, chats.filter(chat => chat.projectId === project.id).map(chatListEntry)]));
  const standalone = chats.filter(chat => !projects.some(project => project.id === chat.projectId)).map(chatListEntry);
  const selected = chatsById.get(route.threadId ?? '');
  const selectedProjectId = selected ? selected.projectId : route.projectId ?? null;
  useEffect(() => {
    const popstate = () => { const next = currentKodexRoute(); setRoute(next); setRouteThreadPaneId(next.threadId); setMobilePanel(next.panel ?? 'chat'); };
    window.addEventListener('popstate', popstate); return () => window.removeEventListener('popstate', popstate);
  }, []);
  const navigate = useCallback((next: Parameters<typeof pushKodexRoute>[0]) => { pushKodexRoute(next); setRoute(next); setMobilePanel('chat'); }, []);
  const selectThread = useCallback((id: string) => { setRouteThreadPaneId(null); navigate({ threadId: id, view: 'thread', panel: null }); }, [navigate]);
  const reportWorkspaceFocus = useCallback((id: string) => {
    if (mainPane !== 'thread') return;
    setRouteThreadPaneId(null);
    const next = { threadId: id, view: 'thread', panel: null } as const;
    // Workspace focus reports selection; it does not create a navigation entry.
    replaceKodexRoute(next);
    setRoute(next);
    setMobilePanel('chat');
  }, [mainPane]);
  const createDraft = useCallback((projectId?: string) => navigate({ threadId: null, projectId: projectId ?? null, view: 'thread', panel: null }), [navigate]);
  useEffect(() => {
    if (!route.threadId || !catalog.snapshot?.archivedChatIds.includes(route.threadId)) return;
    setRouteThreadPaneId(null);
    const next = { threadId: null, view: 'thread', panel: null } as const;
    replaceKodexRoute(next); setRoute(next);
  }, [route.threadId, catalog.snapshot?.archivedChatIds]);
  const nativeError = catalog.error ?? account.error;
  const displayError = error ?? nativeError ?? automations.error;
  const chatDataState = catalog.error ? 'error' : catalog.snapshot ? 'loaded' : 'loading';
  const projectId = route.projectId;
  const projectActions = useMemo(() => projectId ? {
    update: (patch: ProjectFormPatch) => mastraClient.updateProject({ projectId, patch: {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.roots !== undefined ? { roots: patch.roots.map(root => root.path) } : {}),
    } }),
    remove: () => mastraClient.deleteProject({ projectId }),
  } : undefined, [projectId]);
  const loadDirectories = useCallback<DirectoryLoader>((path, signal) => mastraClient.listDirectories(path ? { path } : {}, { signal }), []);
  const createProject = useCallback(async (fields: ProjectCreationFields) => {
    const project = await mastraClient.createProject({ createKey: fields.idempotencyKey, path: fields.roots[0].path });
    return { ...project, roots: project.roots.map(path => ({ path })) };
  }, []);
  return <NativeCatalogProvider snapshot={catalog.snapshot}>
    <WorkspaceProvider liveTransport="external" terminalSessionApi={nativeTerminalApi} paneStore={workspacePaneStore} errorMessage={displayError}
      isVisible={mainPane === 'thread' && (!singlePane || mobilePanel === 'chat')} onFocusThreadPane={reportWorkspaceFocus}
      onShowMobileSidebar={() => setMobilePanel('threads')} onImageOpen={setLightbox}
      onMarkdownOpen={setMarkdownPreview}
      renderThreadPane={pane => <NativeThreadPane pane={pane} draftStore={drafts.current} onError={reportError} />}
      threadActions={{
        onArchiveThread: id => perform(mastraClient.archiveChat({ chatId: id })), onPinThread: metadata.pin, onUnpinThread: metadata.unpin,
        onRenameThread: async (id, name) => { await mastraClient.renameChat({ chatId: id, title: name }); },
        onSetThreadNotificationsEnabled: metadata.setNotifications, pinPending: metadata.pinPending,
      }} showDebugEvents={showDebugEvents}>
      {catalog.snapshot && catalog.snapshot.archivedChatIds.length > 0 ? <NativeArchiveReconciliation archivedChatIds={catalog.snapshot.archivedChatIds} /> : null}
      {mainPane !== 'thread' && displayError ? <Alert color="red" role="alert">{displayError}</Alert> : null}
      <NativeWorkspaceShellView isDraftThreadSelected={!route.threadId} isSidebarResizing={resize.isSidebarResizing}
        mainPane={mainPane} mobilePanel={mobilePanel} sidebarCollapsed={resize.sidebarCollapsed} useSingleThreadWorkspace={singlePane}
        workspaceSelectedThreadPaneId={mainPane === 'thread' ? routeThreadPaneId : null}
        preferencesProps={{ executionPanel: <NativeExecutionPreferencesPanel />, mcpPanel: <NativeMcpPreferencesPanel />, opened: preferencesOpen, activeSection: preferencesSection, resolvedSchemeId: colorSchemeId, preferences: appearance, onClose: () => setPreferencesOpen(false), onSectionChange: setPreferencesSection, onModeChange: onAppearanceModeChange, onThemeChange }}
        projectPaneProps={{ project: projects.find(project => project.id === route.projectId) ?? null, onDeleted: () => createDraft(), actions: projectActions, onShowMobileSidebar: () => setMobilePanel('threads') }}
        automationsPaneProps={{ mode: 'calendar', targetReadOnly: false, renderRuns: id => <NativeAutomationRuns automationId={id} />, automations: automations.rows, defaultThreadId: route.threadId, isLoading: automations.isLoading,
          onCreateAutomation: automations.create, onDeleteAutomation: automations.remove, onPauseAutomation: automations.pause, onResumeAutomation: automations.resume, onUpdateAutomation: automations.update,
          onShowMobileSidebar: () => setMobilePanel('threads'), threadOptions: entries.map(chat => ({ value: chat.id, label: chat.name ?? 'New thread' })) }}
        workspaceSidebarProps={{ account: null, accountMenu: <NativeAccountMenu state={account}
          onSelectAutomations={() => navigate({ threadId: null, view: 'automations', panel: null })}
          onOpenPreferences={() => setPreferencesOpen(true)} onShowDebugEventsChange={setShowDebugEvents} showDebugEvents={showDebugEvents} />, approvals: [], chatThreads: standalone, projects, threadsByProjectId,
          pinnedThreads: pinned, onMovePinnedThread: metadata.movePinned, pinPending: metadata.pinPending, pendingTitleThreadIds: emptyPendingTitles, hoveredThreadActionId,
          dataState: { projects: chatDataState, chatThreads: chatDataState, pinnedThreads: chatDataState, projectThreadsById: Object.fromEntries(projects.map(project => [project.id, chatDataState])) },
          sidebarSnapshotStatus: { failed: Boolean(catalog.error), retrying: !catalog.snapshot && !catalog.error, onRetry: catalog.retry },
          selectedMainPane: mainPane, selectedProjectId, selectedThreadId: route.threadId,
          onCreateChat: () => createDraft(), onCreateThread: createDraft, onCreateProject: () => setProjectFormOpen(true),
          onSelectChatThread: selectThread, onSelectPinnedThread: selectThread, onSelectThread: (_projectId, id) => selectThread(id),
          onSelectProjectSettings: id => navigate({ threadId: null, projectId: id, view: 'project', panel: null }),
          onSelectAutomations: () => navigate({ threadId: null, view: 'automations', panel: null }),
          onArchiveThread: id => perform(mastraClient.archiveChat({ chatId: id })), onPinThread: metadata.pin, onUnpinThread: metadata.unpin,
          onMoveProject: (id, beforeId) => perform(mastraClient.moveProjectBefore({ projectId: id, beforeId })), onLogout: account.logout,
          onOpenPreferences: () => setPreferencesOpen(true), onOpenTerminal: () => navigate({ ...route, view: 'thread', panel: null }), onShowThread: () => setMobilePanel('chat'),
          onShowDebugEventsChange: setShowDebugEvents, showDebugEvents, sidebarWidth: resize.sidebarWidth,
          onSidebarCollapseClick: resize.handleSidebarCollapseClick, onSidebarExpandClick: resize.handleSidebarExpandClick, onThreadActionHoverChange: setHoveredThreadActionId,
        }} />
      {projectFormOpen ? <WorkspaceProjectCreateDialog onCreate={createProject} directoryLoader={loadDirectories} directoryQueryScope={`mastra:${info.instanceId}`} onClose={() => setProjectFormOpen(false)} onCreated={project => createDraft(project.id)} onError={reportError} /> : null}
    </WorkspaceProvider>
    {markdownPreview ? <Suspense fallback={null}><MarkdownPreviewPane preview={markdownPreview} threadId={route.threadId ?? undefined} onClose={() => setMarkdownPreview(null)} /></Suspense> : null}
    {lightbox ? <Suspense fallback={<Group />}><ImageLightbox image={lightbox} onClose={() => setLightbox(null)} /></Suspense> : null}
  </NativeCatalogProvider>;
}
