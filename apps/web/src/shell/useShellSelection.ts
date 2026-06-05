import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

import type { ThreadSummary } from "../api/client";
import type { ThreadsByProjectId } from "../threads/helpers";
import { findKnownThreadSelection as findKnownThreadSelectionInCaches } from "../threads/selection";
import {
  currentKodexRoute,
  historyState,
  isMobileViewport,
  pathForKodexRoute,
  pushKodexRoute,
  replaceKodexRoute,
} from "./browserRouting";
import type { MobilePanel } from "./KodexShellView";
import type { KodexMainPane, KodexRoute } from "./navigation";

type CurrentRef<T> = { current: T };

export type ShellSelectionState = {
  draftChatThreadSelected: boolean;
  draftThreadProjectId: string | null;
  mobilePanel: MobilePanel;
  routeSelectedThread: ThreadSummary | null;
  selectedMainPane: KodexMainPane;
  selectedProjectId: string | null;
  selectedProjectPaneId: string | null;
  selectedThreadId: string | null;
  unavailableThreadId: string | null;
};

export type ShellSelectionActions = {
  applyBrowserRoute: (route: KodexRoute) => void;
  clearSelectionToDraft: (options: { projectId: string | null; resetDraftComposer?: boolean; replaceRoute?: boolean }) => void;
  handleCreateChat: () => void;
  handleCreateThread: (projectId: string) => void;
  handleDraftProjectChange: (projectId: string | null) => void;
  handleSelectAutomations: () => void;
  handleSelectChatThread: (threadId: string) => void;
  handleSelectPinnedThread: (threadId: string) => void;
  handleSelectProjectSettings: (projectId: string) => void;
  handleSelectThread: (projectId: string, threadId: string) => void;
  selectMaterializedThread: (options: { projectId: string | null; thread: ThreadSummary }) => void;
  selectProject: (projectId: string) => void;
  setMobilePanel: (panel: MobilePanel) => void;
  setRouteSelectedThreadState: (thread: ThreadSummary | null) => void;
  setSelectedProjectId: (projectId: string | null) => void;
  setSelectedThreadId: (threadId: string | null) => void;
  setUnavailableThreadId: Dispatch<SetStateAction<string | null>>;
};

export type ShellSelectionRefs = {
  routeSelectedThreadRef: CurrentRef<ThreadSummary | null>;
  selectedProjectIdRef: CurrentRef<string | null>;
  selectedThreadIdRef: CurrentRef<string | null>;
};

export function useShellSelection({
  beginMaterializingTimelineEntry,
  beginTimelineEntry,
  chatThreadsRef,
  clearTimelineEntry,
  composerDefaultsRef,
  initialRoute,
  pinnedThreadsRef,
  resetComposerDraft,
  threadsByProjectIdRef,
}: {
  beginMaterializingTimelineEntry: (threadId: string) => void;
  beginTimelineEntry: (threadId: string) => void;
  chatThreadsRef: CurrentRef<ThreadSummary[]>;
  clearTimelineEntry: () => void;
  composerDefaultsRef: CurrentRef<{
    draftComposerEditedRef: CurrentRef<boolean>;
    hydrateComposerDefaults: (projectId: string | null) => void | Promise<unknown>;
  }>;
  initialRoute: KodexRoute;
  pinnedThreadsRef: CurrentRef<ThreadSummary[]>;
  resetComposerDraft: () => void;
  threadsByProjectIdRef: CurrentRef<ThreadsByProjectId>;
}): ShellSelectionState & ShellSelectionActions & ShellSelectionRefs {
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(initialRoute.projectId ?? null);
  const [selectedMainPane, setSelectedMainPane] = useState<KodexMainPane>(initialRoute.view ?? "thread");
  const [selectedProjectPaneId, setSelectedProjectPaneId] = useState<string | null>(initialRoute.projectId ?? null);
  const [selectedThreadId, setSelectedThreadIdState] = useState<string | null>(initialRoute.threadId);
  const [routeSelectedThread, setRouteSelectedThread] = useState<ThreadSummary | null>(null);
  const [unavailableThreadId, setUnavailableThreadId] = useState<string | null>(null);
  const [draftChatThreadSelected, setDraftChatThreadSelected] = useState(initialRoute.threadId === null);
  const [draftThreadProjectId, setDraftThreadProjectId] = useState<string | null>(null);
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>(initialRoute.panel ?? "chat");
  const selectedProjectIdRef = useRef<string | null>(null);
  const selectedThreadIdRef = useRef<string | null>(selectedThreadId);
  const routeSelectedThreadRef = useRef<ThreadSummary | null>(null);
  const directMobileDeepLinkSeededRef = useRef(false);

  const setSelectedProjectIdWithRef = useCallback((projectId: string | null) => {
    selectedProjectIdRef.current = projectId;
    setSelectedProjectId(projectId);
  }, []);

  const setSelectedThreadIdWithRef = useCallback((threadId: string | null) => {
    selectedThreadIdRef.current = threadId;
    setSelectedThreadIdState(threadId);
  }, []);

  const setRouteSelectedThreadState = useCallback((thread: ThreadSummary | null) => {
    routeSelectedThreadRef.current = thread;
    setRouteSelectedThread(thread);
  }, []);

  useEffect(() => {
    if (initialRoute.threadId) {
      replaceKodexRoute({ panel: initialRoute.panel, threadId: null, view: "thread" });
    }
  }, []);

  const selectKnownProjectThread = useCallback((projectId: string, threadId: string) => {
    setSelectedMainPane("thread");
    setSelectedProjectPaneId(null);
    setMobilePanel("chat");
    if (projectId === selectedProjectIdRef.current && threadId === selectedThreadIdRef.current) {
      return;
    }
    setSelectedProjectIdWithRef(projectId);
    setDraftChatThreadSelected(false);
    setDraftThreadProjectId(null);
    setUnavailableThreadId(null);
    setRouteSelectedThreadState(null);
    setSelectedThreadIdWithRef(threadId);
    beginTimelineEntry(threadId);
  }, [beginTimelineEntry, setRouteSelectedThreadState, setSelectedProjectIdWithRef, setSelectedThreadIdWithRef]);

  const selectKnownChatThread = useCallback((threadId: string) => {
    setSelectedMainPane("thread");
    setSelectedProjectPaneId(null);
    setMobilePanel("chat");
    if (selectedProjectIdRef.current === null && threadId === selectedThreadIdRef.current) {
      return;
    }
    const { draftComposerEditedRef, hydrateComposerDefaults } = composerDefaultsRef.current;
    draftComposerEditedRef.current = false;
    if (!draftComposerEditedRef.current) {
      void hydrateComposerDefaults(null);
    }
    setSelectedProjectIdWithRef(null);
    setDraftChatThreadSelected(false);
    setDraftThreadProjectId(null);
    setUnavailableThreadId(null);
    setRouteSelectedThreadState(null);
    setSelectedThreadIdWithRef(threadId);
    beginTimelineEntry(threadId);
  }, [
    beginTimelineEntry,
    composerDefaultsRef,
    setRouteSelectedThreadState,
    setSelectedProjectIdWithRef,
    setSelectedThreadIdWithRef,
  ]);

  const selectKnownPinnedThread = useCallback((threadId: string) => {
    setSelectedMainPane("thread");
    setSelectedProjectPaneId(null);
    setMobilePanel("chat");
    if (selectedProjectIdRef.current === null && threadId === selectedThreadIdRef.current) {
      return;
    }
    setSelectedProjectIdWithRef(null);
    setDraftChatThreadSelected(false);
    setDraftThreadProjectId(null);
    setUnavailableThreadId(null);
    setRouteSelectedThreadState(null);
    setSelectedThreadIdWithRef(threadId);
    beginTimelineEntry(threadId);
  }, [beginTimelineEntry, setRouteSelectedThreadState, setSelectedProjectIdWithRef, setSelectedThreadIdWithRef]);

  const selectRouteThread = useCallback((threadId: string) => {
    setSelectedMainPane("thread");
    setSelectedProjectPaneId(null);
    const knownSelection = findKnownThreadSelectionInCaches(
      threadId,
      threadsByProjectIdRef.current,
      chatThreadsRef.current,
      pinnedThreadsRef.current,
    );
    if (knownSelection?.kind === "project") {
      selectKnownProjectThread(knownSelection.projectId, threadId);
      return;
    }
    if (knownSelection?.kind === "chat") {
      selectKnownChatThread(threadId);
      return;
    }
    if (knownSelection?.kind === "pinned") {
      selectKnownPinnedThread(threadId);
      return;
    }
    setMobilePanel("chat");
    if (threadId === selectedThreadIdRef.current && selectedProjectIdRef.current === null) {
      return;
    }
    setSelectedProjectIdWithRef(null);
    setDraftChatThreadSelected(false);
    setDraftThreadProjectId(null);
    setUnavailableThreadId(null);
    setRouteSelectedThreadState(null);
    setSelectedThreadIdWithRef(threadId);
    beginTimelineEntry(threadId);
  }, [
    beginTimelineEntry,
    chatThreadsRef,
    pinnedThreadsRef,
    selectKnownChatThread,
    selectKnownPinnedThread,
    selectKnownProjectThread,
    setRouteSelectedThreadState,
    setSelectedProjectIdWithRef,
    setSelectedThreadIdWithRef,
    threadsByProjectIdRef,
  ]);

  const selectProject = useCallback((projectId: string) => {
    setSelectedMainPane("thread");
    setSelectedProjectPaneId(null);
    setSelectedProjectIdWithRef(projectId);
    const { draftComposerEditedRef, hydrateComposerDefaults } = composerDefaultsRef.current;
    if (!draftComposerEditedRef.current) {
      void hydrateComposerDefaults(projectId);
    }
    setSelectedThreadIdWithRef(null);
    setRouteSelectedThreadState(null);
    setUnavailableThreadId(null);
    setDraftChatThreadSelected(false);
    setDraftThreadProjectId(projectId);
    clearTimelineEntry();
  }, [
    clearTimelineEntry,
    composerDefaultsRef,
    setRouteSelectedThreadState,
    setSelectedProjectIdWithRef,
    setSelectedThreadIdWithRef,
  ]);

  const handleCreateThread = useCallback((projectId: string) => {
    setSelectedMainPane("thread");
    setSelectedProjectPaneId(null);
    pushKodexRoute({ panel: null, threadId: null });
    setMobilePanel("chat");
    setSelectedProjectIdWithRef(projectId);
    setDraftChatThreadSelected(false);
    setDraftThreadProjectId(projectId);
    setSelectedThreadIdWithRef(null);
    setRouteSelectedThreadState(null);
    setUnavailableThreadId(null);
    clearTimelineEntry();
    resetComposerDraft();
  }, [clearTimelineEntry, resetComposerDraft, setRouteSelectedThreadState, setSelectedProjectIdWithRef, setSelectedThreadIdWithRef]);

  const handleCreateChat = useCallback(() => {
    setSelectedMainPane("thread");
    setSelectedProjectPaneId(null);
    pushKodexRoute({ panel: null, threadId: null });
    setMobilePanel("chat");
    const { draftComposerEditedRef, hydrateComposerDefaults } = composerDefaultsRef.current;
    draftComposerEditedRef.current = false;
    if (!draftComposerEditedRef.current) {
      void hydrateComposerDefaults(null);
    }
    setSelectedProjectIdWithRef(null);
    setDraftChatThreadSelected(true);
    setDraftThreadProjectId(null);
    setSelectedThreadIdWithRef(null);
    setRouteSelectedThreadState(null);
    setUnavailableThreadId(null);
    clearTimelineEntry();
    resetComposerDraft();
  }, [
    clearTimelineEntry,
    composerDefaultsRef,
    resetComposerDraft,
    setRouteSelectedThreadState,
    setSelectedProjectIdWithRef,
    setSelectedThreadIdWithRef,
  ]);

  const handleDraftProjectChange = useCallback((projectId: string | null) => {
    setSelectedMainPane("thread");
    setSelectedProjectPaneId(null);
    pushKodexRoute({ panel: null, threadId: null });
    setMobilePanel("chat");
    setSelectedThreadIdWithRef(null);
    setRouteSelectedThreadState(null);
    setUnavailableThreadId(null);
    clearTimelineEntry();
    const { draftComposerEditedRef, hydrateComposerDefaults } = composerDefaultsRef.current;

    if (projectId === null) {
      setSelectedProjectIdWithRef(null);
      setDraftChatThreadSelected(true);
      setDraftThreadProjectId(null);
      if (!draftComposerEditedRef.current) {
        void hydrateComposerDefaults(null);
      }
      return;
    }

    setSelectedProjectIdWithRef(projectId);
    setDraftChatThreadSelected(false);
    setDraftThreadProjectId(projectId);
    if (!draftComposerEditedRef.current) {
      void hydrateComposerDefaults(projectId);
    }
  }, [
    clearTimelineEntry,
    composerDefaultsRef,
    setRouteSelectedThreadState,
    setSelectedProjectIdWithRef,
    setSelectedThreadIdWithRef,
  ]);

  const handleSelectThread = useCallback((projectId: string, threadId: string) => {
    pushKodexRoute({ panel: null, threadId: null });
    selectKnownProjectThread(projectId, threadId);
  }, [selectKnownProjectThread]);

  const handleSelectChatThread = useCallback((threadId: string) => {
    pushKodexRoute({ panel: null, threadId: null });
    selectKnownChatThread(threadId);
  }, [selectKnownChatThread]);

  const handleSelectPinnedThread = useCallback((threadId: string) => {
    pushKodexRoute({ panel: null, threadId: null });
    selectKnownPinnedThread(threadId);
  }, [selectKnownPinnedThread]);

  const handleSelectAutomations = useCallback(() => {
    pushKodexRoute({ panel: null, threadId: null, view: "automations" });
    setMobilePanel("chat");
    setSelectedMainPane("automations");
    setSelectedProjectPaneId(null);
  }, []);

  const handleSelectProjectSettings = useCallback((projectId: string) => {
    pushKodexRoute({ panel: null, projectId, threadId: null, view: "project" });
    setMobilePanel("chat");
    setSelectedMainPane("project");
    setSelectedProjectPaneId(projectId);
    setSelectedProjectIdWithRef(projectId);
    setSelectedThreadIdWithRef(null);
    setRouteSelectedThreadState(null);
    setUnavailableThreadId(null);
    setDraftChatThreadSelected(false);
    setDraftThreadProjectId(null);
    clearTimelineEntry();
  }, [clearTimelineEntry, setRouteSelectedThreadState, setSelectedProjectIdWithRef, setSelectedThreadIdWithRef]);

  const clearSelectionToDraft = useCallback(({
    projectId,
    resetDraftComposer,
    replaceRoute,
  }: {
    projectId: string | null;
    resetDraftComposer?: boolean;
    replaceRoute?: boolean;
  }) => {
    clearTimelineEntry();
    setSelectedThreadIdWithRef(null);
    setRouteSelectedThreadState(null);
    setUnavailableThreadId(null);
    if (projectId) {
      const { draftComposerEditedRef, hydrateComposerDefaults } = composerDefaultsRef.current;
      setDraftChatThreadSelected(false);
      setDraftThreadProjectId(projectId);
      if (!draftComposerEditedRef.current) {
        void hydrateComposerDefaults(projectId);
      }
    } else {
      const { draftComposerEditedRef, hydrateComposerDefaults } = composerDefaultsRef.current;
      draftComposerEditedRef.current = false;
      setDraftChatThreadSelected(true);
      setDraftThreadProjectId(null);
      void hydrateComposerDefaults(null);
    }
    if (resetDraftComposer) {
      resetComposerDraft();
    }
    if (replaceRoute) {
      replaceKodexRoute({ panel: null, threadId: null });
    }
  }, [
    clearTimelineEntry,
    composerDefaultsRef,
    resetComposerDraft,
    setRouteSelectedThreadState,
    setSelectedThreadIdWithRef,
  ]);

  const selectMaterializedThread = useCallback(({ projectId, thread }: { projectId: string | null; thread: ThreadSummary }) => {
    setDraftChatThreadSelected(false);
    setDraftThreadProjectId(null);
    setSelectedProjectIdWithRef(projectId);
    setUnavailableThreadId(null);
    setRouteSelectedThreadState(thread);
    beginMaterializingTimelineEntry(thread.id);
    setSelectedThreadIdWithRef(thread.id);
    pushKodexRoute({ panel: null, threadId: null });
  }, [
    beginMaterializingTimelineEntry,
    setRouteSelectedThreadState,
    setSelectedProjectIdWithRef,
    setSelectedThreadIdWithRef,
  ]);

  const applyBrowserRoute = useCallback((route: KodexRoute) => {
    if (route.view === "automations") {
      setMobilePanel(route.panel ?? "chat");
      setSelectedMainPane("automations");
      setSelectedProjectPaneId(null);
      return;
    }
    if (route.view === "project" && route.projectId) {
      setMobilePanel(route.panel ?? "chat");
      setSelectedMainPane("project");
      setSelectedProjectPaneId(route.projectId);
      setSelectedProjectIdWithRef(route.projectId);
      setSelectedThreadIdWithRef(null);
      setRouteSelectedThreadState(null);
      setUnavailableThreadId(null);
      setDraftChatThreadSelected(false);
      setDraftThreadProjectId(null);
      clearTimelineEntry();
      return;
    }
    setSelectedMainPane("thread");
    setSelectedProjectPaneId(null);
    if (!route.threadId) {
      setMobilePanel(route.panel ?? "chat");
      setSelectedProjectIdWithRef(null);
      setSelectedThreadIdWithRef(null);
      setRouteSelectedThreadState(null);
      setUnavailableThreadId(null);
      setDraftChatThreadSelected(true);
      setDraftThreadProjectId(null);
      clearTimelineEntry();
      return;
    }
    if (route.threadId === selectedThreadIdRef.current) {
      setMobilePanel(route.panel ?? "chat");
      return;
    }
    selectRouteThread(route.threadId);
    setMobilePanel(route.panel ?? "chat");
  }, [
    clearTimelineEntry,
    selectRouteThread,
    setRouteSelectedThreadState,
    setSelectedProjectIdWithRef,
    setSelectedThreadIdWithRef,
  ]);

  useEffect(() => {
    function handlePopState() {
      applyBrowserRoute(currentKodexRoute());
    }

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [applyBrowserRoute]);

  useEffect(() => {
    if (directMobileDeepLinkSeededRef.current) {
      return;
    }
    directMobileDeepLinkSeededRef.current = true;
    const route = currentKodexRoute();
    if (!route.threadId || route.panel !== null || !isMobileViewport()) {
      return;
    }
    const state = historyState();
    if (state.kodexDirectMobileDeepLinkSeeded === true) {
      return;
    }
    const nextState = { ...state, kodexDirectMobileDeepLinkSeeded: true };
    window.history.replaceState(nextState, "", pathForKodexRoute({ threadId: route.threadId, panel: "threads" }));
    window.history.pushState(nextState, "", pathForKodexRoute({ threadId: route.threadId, panel: null }));
  }, []);

  return {
    applyBrowserRoute,
    clearSelectionToDraft,
    draftChatThreadSelected,
    draftThreadProjectId,
    handleCreateChat,
    handleCreateThread,
    handleDraftProjectChange,
    handleSelectAutomations,
    handleSelectChatThread,
    handleSelectPinnedThread,
    handleSelectProjectSettings,
    handleSelectThread,
    mobilePanel,
    routeSelectedThread,
    routeSelectedThreadRef,
    selectMaterializedThread,
    selectProject,
    selectedMainPane,
    selectedProjectId,
    selectedProjectIdRef,
    selectedProjectPaneId,
    selectedThreadId,
    selectedThreadIdRef,
    setMobilePanel,
    setRouteSelectedThreadState,
    setSelectedProjectId: setSelectedProjectIdWithRef,
    setSelectedThreadId: setSelectedThreadIdWithRef,
    setUnavailableThreadId,
    unavailableThreadId,
  };
}
