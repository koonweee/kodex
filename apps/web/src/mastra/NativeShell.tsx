import { Alert, Group } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { archiveThread, createAutomation, deleteAutomation, getAccount, listAutomations, listPinnedThreads, logout, moveProject, pauseAutomation, renameThread, resumeAutomation, setThreadNotificationsEnabled, setThreadPinned, updateAutomation } from '../api/client';
import { KodexShellView, useNarrowThreadWorkspace } from '../shell/KodexShellView';
import { currentKodexRoute, pushKodexRoute } from '../shell/browserRouting';
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
import { NativeThreadPane } from './NativeThreadPane';

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
  const account = useQuery({ queryKey: ['mastra-unfinished', 'account'], queryFn: ({ signal }) => getAccount(signal), retry: false });
  const pins = useQuery({ queryKey: ['mastra-unfinished', 'pins'], queryFn: ({ signal }) => listPinnedThreads({ signal }), retry: false });
  const automations = useQuery({ queryKey: ['mastra-unfinished', 'automations'], queryFn: () => listAutomations(), enabled: mainPane === 'automations', retry: false });
  const projects = useMemo(() => info.projects.map(project => ({ id: project.id, name: project.name, roots: [{ path: project.path }] })), [info]);
  const chats = catalog.snapshot?.chats ?? [];
  const entries = chats.map(chatListEntry);
  const threadsByProjectId = Object.fromEntries(projects.map(project => [project.id, chats.filter(chat => chat.projectId === project.id).map(chatListEntry)]));
  const standalone = chats.filter(chat => !projects.some(project => project.id === chat.projectId)).map(chatListEntry);
  const selected = chats.find(chat => chat.id === route.threadId);
  const selectedProjectId = selected?.projectId ?? route.projectId ?? null;
  useEffect(() => {
    const popstate = () => { setRoute(currentKodexRoute()); setMobilePanel(currentKodexRoute().panel ?? 'chat'); };
    window.addEventListener('popstate', popstate); return () => window.removeEventListener('popstate', popstate);
  }, []);
  const navigate = useCallback((next: Parameters<typeof pushKodexRoute>[0]) => { pushKodexRoute(next); setRoute(next); setMobilePanel('chat'); }, []);
  const selectThread = useCallback((id: string) => navigate({ threadId: id, view: 'thread', panel: null }), [navigate]);
  const createDraft = useCallback((projectId?: string) => navigate({ threadId: null, projectId: projectId ?? null, view: 'thread', panel: null }), [navigate]);
  const nativeError = catalog.error;
  const unfinishedError = account.error ?? pins.error ?? automations.error;
  const displayError = error ?? nativeError ?? (unfinishedError ? errorMessageFrom(unfinishedError) : null);
  const chatDataState = catalog.error ? 'error' : catalog.snapshot ? 'loaded' : 'loading';
  return <>
    <WorkspaceProvider liveTransport="external" paneStore={workspacePaneStore} errorMessage={displayError}
      isVisible={mainPane === 'thread' && (!singlePane || mobilePanel === 'chat')} onFocusThreadPane={selectThread}
      onShowMobileSidebar={() => setMobilePanel('threads')} onImageOpen={setLightbox}
      onMarkdownOpen={setMarkdownPreview}
      renderThreadPane={pane => <NativeThreadPane pane={pane} draftStore={drafts.current} onError={reportError} />}
      threadActions={{
        onArchiveThread: id => perform(archiveThread(id)), onPinThread: id => perform(setThreadPinned(id, true)), onUnpinThread: id => perform(setThreadPinned(id, false)),
        onRenameThread: async (id, name) => { await renameThread(id, name); },
        onSetThreadNotificationsEnabled: (id, enabled) => perform(setThreadNotificationsEnabled(id, enabled)),
      }} showDebugEvents={showDebugEvents}>
      {mainPane !== 'thread' && displayError ? <Alert color="red" role="alert">{displayError}</Alert> : null}
      <KodexShellView isDraftThreadSelected={!route.threadId} isSidebarResizing={resize.isSidebarResizing}
        mainPane={mainPane} mobilePanel={mobilePanel} sidebarCollapsed={resize.sidebarCollapsed} useSingleThreadWorkspace={singlePane}
        workspaceSelectedThreadPaneId={mainPane === 'thread' ? route.threadId : null}
        preferencesProps={{ opened: preferencesOpen, activeSection: preferencesSection, resolvedSchemeId: colorSchemeId, preferences: appearance, onClose: () => setPreferencesOpen(false), onSectionChange: setPreferencesSection, onModeChange: onAppearanceModeChange, onThemeChange }}
        projectPaneProps={{ project: projects.find(project => project.id === route.projectId) ?? null, onDeleted: () => createDraft(), onShowMobileSidebar: () => setMobilePanel('threads') }}
        automationsPaneProps={{ automations: automations.data ?? [], defaultThreadId: route.threadId, isLoading: automations.isLoading,
          onCreateAutomation: createAutomation, onDeleteAutomation: deleteAutomation, onPauseAutomation: pauseAutomation, onResumeAutomation: resumeAutomation, onUpdateAutomation: updateAutomation,
          onShowMobileSidebar: () => setMobilePanel('threads'), threadOptions: entries.map(chat => ({ value: chat.id, label: chat.name ?? 'New thread' })) }}
        workspaceSidebarProps={{ account: account.data ?? null, approvals: [], chatThreads: standalone, projects, threadsByProjectId,
          pinnedThreads: pins.data?.threads ?? [], pendingTitleThreadIds: emptyPendingTitles, hoveredThreadActionId,
          dataState: { projects: 'loaded', chatThreads: chatDataState, pinnedThreads: pins.isError ? 'error' : pins.data ? 'loaded' : 'loading', projectThreadsById: Object.fromEntries(projects.map(project => [project.id, chatDataState])) },
          sidebarSnapshotStatus: { failed: Boolean(catalog.error), retrying: !catalog.snapshot && !catalog.error, onRetry: catalog.retry },
          selectedMainPane: mainPane, selectedProjectId, selectedThreadId: route.threadId,
          onCreateChat: () => createDraft(), onCreateThread: createDraft, onCreateProject: () => setProjectFormOpen(true),
          onSelectChatThread: selectThread, onSelectPinnedThread: selectThread, onSelectThread: (_projectId, id) => selectThread(id),
          onSelectProjectSettings: id => navigate({ threadId: null, projectId: id, view: 'project', panel: null }),
          onSelectAutomations: () => navigate({ threadId: null, view: 'automations', panel: null }),
          onArchiveThread: id => perform(archiveThread(id)), onPinThread: id => perform(setThreadPinned(id, true)), onUnpinThread: id => perform(setThreadPinned(id, false)),
          onMoveProject: (id, beforeId) => perform(moveProject(id, beforeId)), onLogout: () => perform(logout()),
          onOpenPreferences: () => setPreferencesOpen(true), onOpenTerminal: () => setMobilePanel('chat'), onShowThread: () => setMobilePanel('chat'),
          onShowDebugEventsChange: setShowDebugEvents, showDebugEvents, sidebarWidth: resize.sidebarWidth,
          onSidebarCollapseClick: resize.handleSidebarCollapseClick, onSidebarExpandClick: resize.handleSidebarExpandClick, onThreadActionHoverChange: setHoveredThreadActionId,
        }} />
      {projectFormOpen ? <WorkspaceProjectCreateDialog onClose={() => setProjectFormOpen(false)} onCreated={project => createDraft(project.id)} onError={reportError} /> : null}
    </WorkspaceProvider>
    {markdownPreview ? <Suspense fallback={null}><MarkdownPreviewPane preview={markdownPreview} threadId={route.threadId ?? undefined} onClose={() => setMarkdownPreview(null)} /></Suspense> : null}
    {lightbox ? <Suspense fallback={<Group />}><ImageLightbox image={lightbox} onClose={() => setLightbox(null)} /></Suspense> : null}
  </>;
}
