import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import {
  deleteTerminalSession,
  type Approval,
  type ApprovalResponse,
  type EventEnvelope,
  type ThreadSummary,
  type TimelineSkillMention,
} from "../api/client";
import type { MarkdownPreviewRequest } from "../files/types";
import type { ImageLightboxImage } from "../images/types";
import { recordLiveEvent } from "../events/liveDiagnostics";
import { createEventStreamClient } from "../events/stream";
import { layoutMatchesWorkspacePanes } from "./workspaceLayoutCodec";
import {
  browserWorkspacePaneStore,
  createDraftThreadPane,
  createPaneId,
  ensureWorkspaceHasActivePane,
  type WorkspacePaneStoreAdapter,
} from "./paneStore";
import {
  resolvePanePlacementHint,
  type WorkspacePaneOpenOptions,
  type WorkspacePanePlacementHintsById,
  type WorkspacePanePlacementIntent,
} from "./panePlacement";
import { paneTargetRecord, type WorkspaceModel, type WorkspacePane, type WorkspacePanePatch } from "./paneTypes";
import { workspaceSubscribedThreadIds } from "./resourceSubscriptions";

type WorkspaceLiveEventHandler = (event: EventEnvelope) => void;
export type ThreadPaneTimelineAction =
  | {
      clientRequestId: string;
      kind: "optimistic_user_started";
      skillMentions: TimelineSkillMention[];
      text: string;
      threadId: string;
    }
  | { clientRequestId: string; kind: "optimistic_user_sent" }
  | { clientRequestId: string; kind: "optimistic_user_removed" };
export type ThreadPaneTimelineActionHandler = (action: ThreadPaneTimelineAction) => void;

export type ThreadComposerState = {
  activeTurnId: string | null;
  isActive: boolean;
  isReady: boolean;
  materializeThreadPane?: (threadId: string, title?: string | null) => void;
  publishThreadPaneTimelineAction: (action: ThreadPaneTimelineAction) => void;
  selectedThreadPresent: boolean;
  thread?: ThreadSummary | null;
};

type ThreadPaneChromeState = {
  isActive: boolean;
  thread: ThreadSummary;
  threadId: string;
};

export type WorkspacePaneTabStatus = "connected" | "connecting" | "error" | "closed";

type WorkspaceProviderProps = {
  approvals?: Approval[];
  children: ReactNode;
  errorMessage?: string | null;
  imagePreviewUrlsByPath?: Record<string, string>;
  onApprovalDecision?: (approval: Approval, decision: ApprovalResponse) => void;
  onFocusThreadPane?: (threadId: string) => void;
  onImageOpen?: (image: ImageLightboxImage) => void;
  onLiveEvent?: (event: EventEnvelope) => void;
  onMarkdownOpen?: (request: MarkdownPreviewRequest) => void;
  onShowMobileSidebar?: () => void;
  onThreadSnapshotLoadFailed?: (threadId: string) => void;
  onThreadSnapshotLoaded?: (thread: ThreadSummary) => void;
  onVisibleThreadIdsChange?: (threadIds: string[]) => void;
  paneStore?: WorkspacePaneStoreAdapter;
  publishThreadPaneTimelineAction?: (action: ThreadPaneTimelineAction) => void;
  renderThreadComposer?: (pane: WorkspacePane, state: ThreadComposerState) => ReactNode;
  renderThreadPaneAside?: (pane: WorkspacePane, state: ThreadPaneChromeState) => ReactNode;
  renderThreadPaneHeaderActions?: (pane: WorkspacePane, state: ThreadPaneChromeState) => ReactNode;
  renderThreadPane?: (pane: WorkspacePane, fallback: ReactNode) => ReactNode;
  showDebugEvents?: boolean;
  subscribeThreadPaneTimelineAction?: (handler: ThreadPaneTimelineActionHandler) => () => void;
  threadSummariesById?: Record<string, ThreadSummary>;
  threadActions?: WorkspaceThreadActions;
};

type WorkspaceContextValue = {
  approvals: Approval[];
  closePane: (paneId: string, dockviewLayout: unknown) => void;
  duplicatePane: (paneId: string) => void;
  errorMessage: string | null;
  focusPane: (paneId: string | null) => void;
  imagePreviewUrlsByPath: Record<string, string>;
  isLoading: boolean;
  onApprovalDecision: (approval: Approval, decision: ApprovalResponse) => void;
  onImageOpen: (image: ImageLightboxImage) => void;
  onMarkdownOpen: (request: MarkdownPreviewRequest) => void;
  onShowMobileSidebar: () => void;
  onThreadSnapshotLoadFailed: (threadId: string) => void;
  onThreadSnapshotLoaded: (thread: ThreadSummary) => void;
  onVisiblePaneIdsChange: (paneIds: string[]) => void;
  openDraftThreadPane: (projectId?: string | null, options?: WorkspacePaneOpenOptions) => Promise<void>;
  openGeneratedUiPane: (threadId: string, title?: string | null, options?: WorkspacePaneOpenOptions) => Promise<void>;
  openTerminalPane: (options?: WorkspacePaneOpenOptions & { command?: string | null; cwd?: string | null }) => Promise<void>;
  openThreadPane: (threadId: string, title?: string | null, options?: WorkspacePaneOpenOptions) => Promise<void>;
  paneHeaderActionsById: Record<string, ReactNode>;
  panePlacementHintsById: WorkspacePanePlacementHintsById;
  paneTabStatusById: Record<string, WorkspacePaneTabStatus>;
  persistLayout: (dockviewLayout: unknown, activePaneId: string | null) => void;
  publishThreadPaneTimelineAction: (action: ThreadPaneTimelineAction) => void;
  renderThreadComposer?: (pane: WorkspacePane, state: Omit<ThreadComposerState, "publishThreadPaneTimelineAction">) => ReactNode;
  renderThreadPaneAside?: (pane: WorkspacePane, state: ThreadPaneChromeState) => ReactNode;
  renderThreadPaneHeaderActions?: (pane: WorkspacePane, state: ThreadPaneChromeState) => ReactNode;
  renderThreadPane?: (pane: WorkspacePane, fallback: ReactNode) => ReactNode;
  showDebugEvents: boolean;
  subscribeLiveEvent: (handler: WorkspaceLiveEventHandler) => () => void;
  subscribeThreadPaneTimelineAction: (handler: ThreadPaneTimelineActionHandler) => () => void;
  clearPanePlacementHints: (paneIds: string[]) => void;
  setPaneHeaderActions: (paneId: string, actions: ReactNode | null) => void;
  setPaneTabStatus: (paneId: string, status: WorkspacePaneTabStatus | null) => void;
  threadSummariesById: Record<string, ThreadSummary>;
  threadActions: WorkspaceThreadActions;
  updatePane: (paneId: string, request: WorkspacePanePatch) => Promise<void>;
  workspace: WorkspaceModel;
  workspaceError: Error | null;
};

export type WorkspaceThreadActions = {
  onArchiveThread?: (threadId: string) => void;
  onPinThread?: (threadId: string) => void;
  onRenameThread?: (threadId: string, name: string) => Promise<void>;
  onSetThreadNotificationsEnabled?: (threadId: string, enabled: boolean) => void;
  onUnpinThread?: (threadId: string) => void;
};

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);
const noopPublishThreadPaneTimelineAction = () => undefined;
const noopSubscribeThreadPaneTimelineAction = () => () => undefined;

export function WorkspaceProvider({
  approvals = [],
  children,
  errorMessage = null,
  imagePreviewUrlsByPath = {},
  onApprovalDecision = () => undefined,
  onFocusThreadPane,
  onImageOpen = () => undefined,
  onLiveEvent,
  onMarkdownOpen = () => undefined,
  onShowMobileSidebar = () => undefined,
  onThreadSnapshotLoadFailed = () => undefined,
  onThreadSnapshotLoaded = () => undefined,
  onVisibleThreadIdsChange = () => undefined,
  paneStore = browserWorkspacePaneStore,
  publishThreadPaneTimelineAction = noopPublishThreadPaneTimelineAction,
  renderThreadComposer,
  renderThreadPaneAside,
  renderThreadPaneHeaderActions,
  renderThreadPane,
  showDebugEvents = false,
  subscribeThreadPaneTimelineAction = noopSubscribeThreadPaneTimelineAction,
  threadSummariesById = {},
  threadActions = {},
}: WorkspaceProviderProps) {
  const liveEventCursorRef = useRef<number | undefined>(undefined);
  const liveEventHandlersRef = useRef(new Set<WorkspaceLiveEventHandler>());
  const onLiveEventRef = useRef(onLiveEvent);
  const [paneHeaderActionsById, setPaneHeaderActionsById] = useState<Record<string, ReactNode>>({});
  const [panePlacementHintsById, setPanePlacementHintsById] = useState<WorkspacePanePlacementHintsById>({});
  const [paneTabStatusById, setPaneTabStatusById] = useState<Record<string, WorkspacePaneTabStatus>>({});
  const [visiblePaneIds, setVisiblePaneIds] = useState<string[]>([]);
  const [workspace, setWorkspace] = useState<WorkspaceModel>(() => ensureWorkspaceHasActivePane(paneStore.load()));
  const [workspaceError, setWorkspaceError] = useState<Error | null>(null);
  const workspaceRef = useRef(workspace);

  useEffect(() => {
    onLiveEventRef.current = onLiveEvent;
  }, [onLiveEvent]);

  useEffect(() => {
    workspaceRef.current = workspace;
  }, [workspace]);

  useEffect(() => {
    const paneIds = new Set(workspace.panes.map((pane) => pane.id));
    setPanePlacementHintsById((current) => {
      let changed = false;
      const next: WorkspacePanePlacementHintsById = {};
      for (const [paneId, hint] of Object.entries(current)) {
        if (paneIds.has(paneId)) {
          next[paneId] = hint;
        } else {
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [workspace.panes]);

  useEffect(() => {
    const paneIds = new Set(workspace.panes.map((pane) => pane.id));
    setPaneTabStatusById((current) => {
      let changed = false;
      const next: Record<string, WorkspacePaneTabStatus> = {};
      for (const [paneId, status] of Object.entries(current)) {
        if (paneIds.has(paneId)) {
          next[paneId] = status;
        } else {
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [workspace.panes]);

  useEffect(() => {
    try {
      paneStore.save(workspace);
      setWorkspaceError(null);
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error : new Error("Unable to persist workspace panes."));
    }
  }, [paneStore, workspace]);

  const activeFocusedThreadId = useMemo(() => {
    const activePane = workspace.activePaneId
      ? workspace.panes.find((pane) => pane.id === workspace.activePaneId) ?? null
      : null;
    return activePane?.kind === "thread" && activePane.target.mode === "existing" ? activePane.target.threadId : null;
  }, [workspace.activePaneId, workspace.panes]);

  useEffect(() => {
    if (activeFocusedThreadId) {
      onFocusThreadPane?.(activeFocusedThreadId);
    }
  }, [activeFocusedThreadId, onFocusThreadPane]);

  const onVisiblePaneIdsChange = useCallback((paneIds: string[]) => {
    setVisiblePaneIds((current) => (sameStringArray(current, paneIds) ? current : paneIds));
  }, []);

  const visibleThreadIds = useMemo(
    () => visibleThreadIdsForPaneIds(workspace.panes, visiblePaneIds),
    [visiblePaneIds, workspace.panes],
  );

  useEffect(() => {
    onVisibleThreadIdsChange(visibleThreadIds);
  }, [onVisibleThreadIdsChange, visibleThreadIds]);

  const subscribedThreadIds = useMemo(() => workspaceSubscribedThreadIds(workspace.panes), [workspace.panes]);
  const subscribedThreadIdsKey = subscribedThreadIds.join("\n");

  useEffect(() => {
    const client = createEventStreamClient({
      cursor: liveEventCursorRef.current,
      includeGlobal: true,
      threadIds: subscribedThreadIds,
      onEvent: (event) => {
        recordLiveEvent("global", event);
        liveEventCursorRef.current = Math.max(liveEventCursorRef.current ?? 0, event.seq);
        onLiveEventRef.current?.(event);
        for (const handler of liveEventHandlersRef.current) {
          handler(event);
        }
      },
    });
    client.connect();
    return client.close;
  }, [subscribedThreadIdsKey]);

  const subscribeLiveEvent = useCallback((handler: WorkspaceLiveEventHandler) => {
    liveEventHandlersRef.current.add(handler);
    return () => {
      liveEventHandlersRef.current.delete(handler);
    };
  }, []);

  const setPaneHeaderActions = useCallback((paneId: string, actions: ReactNode | null) => {
    setPaneHeaderActionsById((current) => {
      if (actions === null) {
        if (!Object.prototype.hasOwnProperty.call(current, paneId)) {
          return current;
        }
        const { [paneId]: _removed, ...rest } = current;
        return rest;
      }
      if (current[paneId] === actions) {
        return current;
      }
      return {
        ...current,
        [paneId]: actions,
      };
    });
  }, []);

  const setPaneTabStatus = useCallback((paneId: string, status: WorkspacePaneTabStatus | null) => {
    setPaneTabStatusById((current) => {
      if (status === null) {
        if (!Object.prototype.hasOwnProperty.call(current, paneId)) {
          return current;
        }
        const { [paneId]: _removed, ...rest } = current;
        return rest;
      }
      if (current[paneId] === status) {
        return current;
      }
      return {
        ...current,
        [paneId]: status,
      };
    });
  }, []);

  const clearPanePlacementHints = useCallback((paneIds: string[]) => {
    if (paneIds.length === 0) {
      return;
    }
    setPanePlacementHintsById((current) => {
      let changed = false;
      const next = { ...current };
      for (const paneId of paneIds) {
        if (Object.prototype.hasOwnProperty.call(next, paneId)) {
          delete next[paneId];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, []);

  const recordPanePlacementHint = useCallback((
    paneId: string,
    intent: WorkspacePanePlacementIntent,
    options: WorkspacePaneOpenOptions = {},
  ) => {
    const hint = resolvePanePlacementHint(workspaceRef.current, intent, options.placement);
    if (!hint) {
      return;
    }
    setPanePlacementHintsById((current) => ({
      ...current,
      [paneId]: hint,
    }));
  }, []);

  const persistLayout = useCallback((dockviewLayout: unknown, activePaneId: string | null) => {
    setWorkspace((current) => {
      if (!layoutMatchesWorkspacePanes(dockviewLayout, current.panes)) {
        return current;
      }
      if (current.activePaneId === activePaneId && stableJsonKey(current.dockviewLayout) === stableJsonKey(dockviewLayout)) {
        return current;
      }
      return ensureWorkspaceHasActivePane({
        ...current,
        activePaneId,
        dockviewLayout,
      });
    });
  }, []);

  const focusPane = useCallback((paneId: string | null) => {
    setWorkspace((current) => {
      if (current.activePaneId === paneId) {
        return current;
      }
      return ensureWorkspaceHasActivePane({
        ...current,
        activePaneId: paneId,
      });
    });
  }, []);

  const closePane = useCallback((paneId: string, dockviewLayout: unknown) => {
    const paneToClose = workspace.panes.find((pane) => pane.id === paneId) ?? null;
    if (paneToClose?.kind === "terminal" && typeof paneToClose.target.terminalId === "string") {
      void deleteTerminalSession(paneToClose.target.terminalId).catch((error: unknown) => {
        setWorkspaceError(error instanceof Error ? error : new Error("Terminal session could not be stopped."));
      });
    }
    setWorkspace((current) => {
      const remainingPanes = current.panes.filter((pane) => pane.id !== paneId);
      if (remainingPanes.length === current.panes.length) {
        return current;
      }
      const panes = remainingPanes.length > 0 ? remainingPanes : [createDraftThreadPane()];
      const activePaneId = current.activePaneId === paneId
        ? panes[0]?.id ?? null
        : panes.some((pane) => pane.id === current.activePaneId)
          ? current.activePaneId
          : panes[0]?.id ?? null;
      return {
        ...current,
        activePaneId,
        dockviewLayout: layoutMatchesWorkspacePanes(dockviewLayout, panes) ? dockviewLayout : null,
        panes,
      };
    });
  }, [workspace.panes]);

  const updatePane = useCallback(async (paneId: string, request: WorkspacePanePatch) => {
    setWorkspace((current) => {
      let changed = false;
      const panes = current.panes.map((pane) => {
        if (pane.id !== paneId) {
          return pane;
        }
        const nextTarget = request.target ?? pane.target;
        const nextTitle = Object.prototype.hasOwnProperty.call(request, "title") && request.title !== undefined
          ? request.title ?? null
          : pane.title;
        if (nextTarget === pane.target && nextTitle === pane.title) {
          return pane;
        }
        changed = true;
        return {
          ...pane,
          target: nextTarget,
          title: nextTitle,
        } as WorkspacePane;
      });
      if (!changed) {
        return current;
      }
      return ensureWorkspaceHasActivePane({
        ...current,
        dockviewLayout: layoutMatchesWorkspacePanes(current.dockviewLayout, panes) ? current.dockviewLayout : null,
        panes,
      });
    });
  }, []);

  const openPane = useCallback((
    pane: WorkspacePane,
    intent: WorkspacePanePlacementIntent,
    options: WorkspacePaneOpenOptions = {},
  ) => {
    const current = workspaceRef.current;
    const willAppend = options.duplicate || !current.panes.some(
      (candidate) => stableJsonKey(paneIdentity(candidate)) === stableJsonKey(paneIdentity(pane)),
    );
    if (willAppend) {
      recordPanePlacementHint(pane.id, intent, options);
    }
    setWorkspace((current) => {
      if (!options.duplicate) {
        const targetKey = stableJsonKey(paneIdentity(pane));
        const existing = current.panes.find(
          (candidate) => stableJsonKey(paneIdentity(candidate)) === targetKey,
        );
        if (existing) {
          const nextPanes = pane.title && !existing.title
            ? current.panes.map((candidate) =>
                candidate.id === existing.id ? ({ ...candidate, title: pane.title } as WorkspacePane) : candidate,
              )
            : current.panes;
          if (current.activePaneId === existing.id && nextPanes === current.panes) {
            return current;
          }
          return {
            ...current,
            panes: nextPanes,
            activePaneId: existing.id,
          };
        }
      }
      return {
        ...current,
        activePaneId: pane.id,
        dockviewLayout: null,
        panes: [...current.panes, pane],
      };
    });
  }, [recordPanePlacementHint]);

  const duplicatePane = useCallback((paneId: string) => {
    const sourcePane = workspaceRef.current.panes.find((candidate) => candidate.id === paneId);
    if (!sourcePane) {
      return;
    }
    const duplicatedPane = duplicateWorkspacePane(sourcePane);
    recordPanePlacementHint(duplicatedPane.id, "duplicate", { placement: { sourcePaneId: paneId } });
    setWorkspace((current) => {
      const pane = current.panes.find((candidate) => candidate.id === paneId);
      if (!pane) {
        return current;
      }
      return {
        ...current,
        activePaneId: duplicatedPane.id,
        dockviewLayout: null,
        panes: [...current.panes, duplicatedPane],
      };
    });
  }, [recordPanePlacementHint]);

  const openThreadPane = useCallback(
    async (threadId: string, title?: string | null, options: WorkspacePaneOpenOptions = {}) => {
      const pane: WorkspacePane = {
        id: createPaneId("thread"),
        kind: "thread",
        target: { mode: "existing", threadId },
        title: title ?? null,
      };
      if (options.duplicate) {
        openPane(pane, "duplicate", options);
        return;
      }
      const current = workspaceRef.current;
      if (!current.panes.some((candidate) => stableJsonKey(paneIdentity(candidate)) === stableJsonKey(paneIdentity(pane)))) {
        recordPanePlacementHint(pane.id, "thread", options);
      }
      setWorkspace((current) => {
        const targetKey = stableJsonKey(paneIdentity(pane));
        const existing = current.panes.find(
          (candidate) => stableJsonKey(paneIdentity(candidate)) === targetKey,
        );
        if (existing) {
          const nextPanes = pane.title && !existing.title
            ? current.panes.map((candidate) =>
                candidate.id === existing.id ? ({ ...candidate, title: pane.title } as WorkspacePane) : candidate,
              )
            : current.panes;
          if (current.activePaneId === existing.id && nextPanes === current.panes) {
            return current;
          }
          return {
            ...current,
            panes: nextPanes,
            activePaneId: existing.id,
          };
        }

        return {
          ...current,
          activePaneId: pane.id,
          dockviewLayout: null,
          panes: [...current.panes, pane],
        };
      });
    },
    [openPane, recordPanePlacementHint],
  );

  const openDraftThreadPane = useCallback(
    async (projectId?: string | null, options: WorkspacePaneOpenOptions = {}) => {
      openPane(createDraftThreadPane(projectId), "draftThread", options);
    },
    [openPane],
  );

  const openGeneratedUiPane = useCallback(
    async (threadId: string, title?: string | null, options: WorkspacePaneOpenOptions = {}) => {
      openPane({
        id: createPaneId("generatedUi"),
        kind: "generatedUi",
        target: { mode: "latest", threadId },
        title: title ?? "Generated UI",
      }, "generatedUi", options);
    },
    [openPane],
  );

  const openTerminalPane = useCallback(
    async (options: WorkspacePaneOpenOptions & { command?: string | null; cwd?: string | null } = {}) => {
      openPane(
        {
          id: createPaneId("terminal"),
          kind: "terminal",
          target: {
            command: options.command ?? null,
            cwd: options.cwd ?? null,
          },
          title: "Terminal",
        },
        "terminal",
        { ...options, duplicate: true },
      );
    },
    [openPane],
  );

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      approvals,
      closePane,
      duplicatePane,
      errorMessage,
      focusPane,
      imagePreviewUrlsByPath,
      isLoading: false,
      onApprovalDecision,
      onImageOpen,
      onMarkdownOpen,
      onShowMobileSidebar,
      onThreadSnapshotLoadFailed,
      onThreadSnapshotLoaded,
      onVisiblePaneIdsChange,
      openDraftThreadPane,
      openGeneratedUiPane,
      openTerminalPane,
      openThreadPane,
      paneHeaderActionsById,
      panePlacementHintsById,
      paneTabStatusById,
      persistLayout,
      publishThreadPaneTimelineAction,
      renderThreadComposer: renderThreadComposer
        ? (pane, state) =>
            renderThreadComposer(pane, {
              ...state,
              publishThreadPaneTimelineAction,
            })
        : undefined,
      renderThreadPaneAside,
      renderThreadPaneHeaderActions,
      renderThreadPane,
      showDebugEvents,
      subscribeLiveEvent,
      subscribeThreadPaneTimelineAction,
      clearPanePlacementHints,
      setPaneHeaderActions,
      setPaneTabStatus,
      threadSummariesById,
      threadActions,
      updatePane,
      workspace,
      workspaceError,
    }),
    [
      approvals,
      closePane,
      duplicatePane,
      errorMessage,
      focusPane,
      imagePreviewUrlsByPath,
      onApprovalDecision,
      onImageOpen,
      onMarkdownOpen,
      onShowMobileSidebar,
      onThreadSnapshotLoadFailed,
      onThreadSnapshotLoaded,
      onVisiblePaneIdsChange,
      openDraftThreadPane,
      openGeneratedUiPane,
      openTerminalPane,
      openThreadPane,
      paneHeaderActionsById,
      panePlacementHintsById,
      paneTabStatusById,
      persistLayout,
      publishThreadPaneTimelineAction,
      renderThreadComposer,
      renderThreadPaneAside,
      renderThreadPaneHeaderActions,
      renderThreadPane,
      showDebugEvents,
      subscribeLiveEvent,
      subscribeThreadPaneTimelineAction,
      clearPanePlacementHints,
      setPaneHeaderActions,
      setPaneTabStatus,
      threadSummariesById,
      threadActions,
      updatePane,
      workspace,
      workspaceError,
    ],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace() {
  const value = useContext(WorkspaceContext);
  if (!value) {
    throw new Error("useWorkspace must be used within WorkspaceProvider");
  }
  return value;
}

function duplicateWorkspacePane(pane: WorkspacePane): WorkspacePane {
  if (pane.kind === "terminal") {
    const { terminalId: _terminalId, ...target } = pane.target;
    return {
      ...pane,
      id: createPaneId("terminal"),
      target,
      title: pane.title ?? "Terminal",
    };
  }
  return {
    ...pane,
    id: createPaneId(pane.kind),
  };
}

function visibleThreadIdsForPaneIds(panes: WorkspacePane[], paneIds: string[]): string[] {
  const visiblePaneIds = new Set(paneIds);
  const threadIds = new Set<string>();
  for (const pane of panes) {
    if (!visiblePaneIds.has(pane.id)) {
      continue;
    }
    const target = paneTargetRecord(pane);
    if (pane.kind === "thread" && target.mode === "existing" && typeof target.threadId === "string") {
      threadIds.add(target.threadId);
    }
  }
  return Array.from(threadIds).sort();
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function stableJsonKey(value: unknown): string {
  return JSON.stringify(value);
}

function paneIdentity(pane: WorkspacePane): unknown {
  if (pane.kind === "thread" && pane.target.mode === "draft") {
    return {
      kind: pane.kind,
      target: {
        mode: "draft",
        projectId: pane.target.projectId ?? null,
      },
    };
  }
  return {
    kind: pane.kind,
    target: pane.target,
  };
}
