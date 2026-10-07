import { readNarrowWorkspace } from "../shared/layoutBreakpoints";
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

import type { ThreadSummary } from "../api/client";
import type { ThreadsByProjectId } from "../threads/helpers";
import { findKnownThreadSelection as findKnownThreadSelectionInCaches } from "../threads/selection";
import {
  currentKodexRoute,
  historyState,
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
  routeThreadPaneId: string | null;
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
  handleFocusWorkspaceThreadPane: (threadId: string) => void;
  handleSelectAutomations: () => void;
  handleShowWorkspace: () => void;
  handleSelectChatThread: (threadId: string) => void;
  handleSelectPinnedThread: (threadId: string) => void;
  handleSelectProjectSettings: (projectId: string) => void;
  handleSelectThread: (projectId: string, threadId: string) => void;
  selectMaterializedThread: (options: { projectId: string | null; thread: ThreadSummary }) => void;
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
  chatThreadsRef,
  initialRoute,
  pinnedThreadsRef,
  resetComposerDraft,
  threadsByProjectIdRef,
}: {
  chatThreadsRef: CurrentRef<ThreadSummary[]>;
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
  const [routeThreadPaneId, setRouteThreadPaneId] = useState<string | null>(initialRoute.threadId);
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
  }, [setRouteSelectedThreadState, setSelectedProjectIdWithRef, setSelectedThreadIdWithRef]);

  const selectKnownChatThread = useCallback((threadId: string) => {
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
  }, [
    setRouteSelectedThreadState,
    setSelectedProjectIdWithRef,
    setSelectedThreadIdWithRef,
  ]);

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
  }, [
    chatThreadsRef,
    pinnedThreadsRef,
    selectKnownChatThread,
    selectKnownProjectThread,
    setRouteSelectedThreadState,
    setSelectedProjectIdWithRef,
    setSelectedThreadIdWithRef,
    threadsByProjectIdRef,
  ]);

  const handleCreateThread = useCallback((projectId: string) => {
    setRouteThreadPaneId(null);
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
    resetComposerDraft();
  }, [resetComposerDraft, setRouteSelectedThreadState, setSelectedProjectIdWithRef, setSelectedThreadIdWithRef]);

  const handleCreateChat = useCallback(() => {
    setRouteThreadPaneId(null);
    setSelectedMainPane("thread");
    setSelectedProjectPaneId(null);
    pushKodexRoute({ panel: null, threadId: null });
    setMobilePanel("chat");
    setSelectedProjectIdWithRef(null);
    setDraftChatThreadSelected(true);
    setDraftThreadProjectId(null);
    setSelectedThreadIdWithRef(null);
    setRouteSelectedThreadState(null);
    setUnavailableThreadId(null);
    resetComposerDraft();
  }, [
    resetComposerDraft,
    setRouteSelectedThreadState,
    setSelectedProjectIdWithRef,
    setSelectedThreadIdWithRef,
  ]);

  const handleDraftProjectChange = useCallback((projectId: string | null) => {
    setRouteThreadPaneId(null);
    setSelectedMainPane("thread");
    setSelectedProjectPaneId(null);
    pushKodexRoute({ panel: null, threadId: null });
    setMobilePanel("chat");
    setSelectedThreadIdWithRef(null);
    setRouteSelectedThreadState(null);
    setUnavailableThreadId(null);

    if (projectId === null) {
      setSelectedProjectIdWithRef(null);
      setDraftChatThreadSelected(true);
      setDraftThreadProjectId(null);
      return;
    }

    setSelectedProjectIdWithRef(projectId);
    setDraftChatThreadSelected(false);
    setDraftThreadProjectId(projectId);
  }, [
    setRouteSelectedThreadState,
    setSelectedProjectIdWithRef,
    setSelectedThreadIdWithRef,
  ]);

  const handleSelectThread = useCallback((projectId: string, threadId: string) => {
    setRouteThreadPaneId(null);
    pushKodexRoute({ panel: null, threadId: null });
    selectKnownProjectThread(projectId, threadId);
  }, [selectKnownProjectThread]);

  const handleSelectChatThread = useCallback((threadId: string) => {
    setRouteThreadPaneId(null);
    pushKodexRoute({ panel: null, threadId: null });
    selectKnownChatThread(threadId);
  }, [selectKnownChatThread]);

  const handleSelectPinnedThread = useCallback((threadId: string) => {
    setRouteThreadPaneId(null);
    pushKodexRoute({ panel: null, threadId: null });
    selectRouteThread(threadId);
  }, [selectRouteThread]);

  const handleFocusWorkspaceThreadPane = useCallback((threadId: string) => {
    setRouteThreadPaneId(null);
    selectRouteThread(threadId);
  }, [selectRouteThread]);

  const handleSelectAutomations = useCallback(() => {
    setRouteThreadPaneId(null);
    pushKodexRoute({ panel: null, threadId: null, view: "automations" });
    setMobilePanel("chat");
    setSelectedMainPane("automations");
    setSelectedProjectPaneId(null);
  }, []);

  const handleShowWorkspace = useCallback(() => {
    setRouteThreadPaneId(null);
    setSelectedMainPane("thread");
    setSelectedProjectPaneId(null);
    setMobilePanel("chat");
    pushKodexRoute({ panel: null, threadId: null, view: "thread" });
  }, []);

  const handleSelectProjectSettings = useCallback((projectId: string) => {
    setRouteThreadPaneId(null);
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
  }, [setRouteSelectedThreadState, setSelectedProjectIdWithRef, setSelectedThreadIdWithRef]);

  const clearSelectionToDraft = useCallback(({
    projectId,
    resetDraftComposer,
    replaceRoute,
  }: {
    projectId: string | null;
    resetDraftComposer?: boolean;
    replaceRoute?: boolean;
  }) => {
    setRouteThreadPaneId(null);
    setSelectedThreadIdWithRef(null);
    setRouteSelectedThreadState(null);
    setUnavailableThreadId(null);
    if (projectId) {
      setDraftChatThreadSelected(false);
      setDraftThreadProjectId(projectId);
    } else {
      setDraftChatThreadSelected(true);
      setDraftThreadProjectId(null);
    }
    if (resetDraftComposer) {
      resetComposerDraft();
    }
    if (replaceRoute) {
      replaceKodexRoute({ panel: null, threadId: null });
    }
  }, [
    resetComposerDraft,
    setRouteSelectedThreadState,
    setSelectedThreadIdWithRef,
  ]);

  const selectMaterializedThread = useCallback(({ projectId, thread }: { projectId: string | null; thread: ThreadSummary }) => {
    setRouteThreadPaneId(null);
    setDraftChatThreadSelected(false);
    setDraftThreadProjectId(null);
    setSelectedProjectIdWithRef(projectId);
    setUnavailableThreadId(null);
    setRouteSelectedThreadState(thread);
    setSelectedThreadIdWithRef(thread.id);
    pushKodexRoute({ panel: null, threadId: null });
  }, [
    setRouteSelectedThreadState,
    setSelectedProjectIdWithRef,
    setSelectedThreadIdWithRef,
  ]);

  const applyBrowserRoute = useCallback((route: KodexRoute) => {
    if (route.view === "automations") {
      setRouteThreadPaneId(null);
      setMobilePanel(route.panel ?? "chat");
      setSelectedMainPane("automations");
      setSelectedProjectPaneId(null);
      return;
    }
    if (route.view === "project" && route.projectId) {
      setRouteThreadPaneId(null);
      setMobilePanel(route.panel ?? "chat");
      setSelectedMainPane("project");
      setSelectedProjectPaneId(route.projectId);
      setSelectedProjectIdWithRef(route.projectId);
      setSelectedThreadIdWithRef(null);
      setRouteSelectedThreadState(null);
      setUnavailableThreadId(null);
      setDraftChatThreadSelected(false);
      setDraftThreadProjectId(null);
        return;
    }
    setSelectedMainPane("thread");
    setSelectedProjectPaneId(null);
    if (!route.threadId) {
      setRouteThreadPaneId(null);
      setMobilePanel(route.panel ?? "chat");
      setSelectedProjectIdWithRef(null);
      setSelectedThreadIdWithRef(null);
      setRouteSelectedThreadState(null);
      setUnavailableThreadId(null);
      setDraftChatThreadSelected(true);
      setDraftThreadProjectId(null);
        return;
    }
    setRouteThreadPaneId(route.threadId);
    if (route.threadId === selectedThreadIdRef.current) {
      setMobilePanel(route.panel ?? "chat");
      return;
    }
    selectRouteThread(route.threadId);
    setMobilePanel(route.panel ?? "chat");
  }, [
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
    if (!route.threadId || route.panel !== null || !readNarrowWorkspace()) {
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
    handleShowWorkspace,
    applyBrowserRoute,
    clearSelectionToDraft,
    draftChatThreadSelected,
    draftThreadProjectId,
    handleCreateChat,
    handleCreateThread,
    handleDraftProjectChange,
    handleFocusWorkspaceThreadPane,
    handleSelectAutomations,
    handleSelectChatThread,
    handleSelectPinnedThread,
    handleSelectProjectSettings,
    handleSelectThread,
    mobilePanel,
    routeSelectedThread,
    routeSelectedThreadRef,
    routeThreadPaneId,
    selectMaterializedThread,
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
