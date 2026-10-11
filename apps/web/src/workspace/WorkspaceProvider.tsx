import { useThreadDeliveryPreferences } from "../timeline/ThreadDeliveryPreferences";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";

import {
  type Approval,
  type CreateTerminalSession,
  type ApprovalResponse,
  type EventEnvelope,
  type ThreadSummary,
  type TimelineSkillMention,
} from "../api/client";
import { useAvailableExecutorIds, useExecutorConnection, useExecutorRuntimes, useGatewayInstanceStorage, useGatewayInstanceValidation, useGatewayStreamConnected } from "../api/GatewayClientContext";
import type { MarkdownPreviewRequest } from "../files/types";
import type { ImageLightboxImage } from "../images/types";
import { recordLiveEvent } from "../events/liveDiagnostics";
import { createEventStreamClient } from "../events/stream";
import { applyApprovalInvalidation } from "../approvals/cache";
import { layoutMatchesWorkspacePanes } from "./workspaceLayoutCodec";
import {
  createBrowserWorkspacePaneStore,
  createDraftThreadPane,
  createPaneId,
  ensureWorkspaceHasActivePane,
  LOCAL_EXECUTOR_ID,
  type WorkspacePaneStoreAdapter,
} from "./paneStore";
import {
  resolvePanePlacementHint,
  type WorkspacePaneOpenOptions,
  type WorkspacePanePlacementHintsById,
  type WorkspacePanePlacementIntent,
} from "./panePlacement";
import { paneTargetRecord, type WorkspaceModel, type WorkspacePane, type WorkspacePanePatch } from "./paneTypes";
import { usePaneThreadContexts, type PaneThreadContext } from "./usePaneThreadContexts";
import { useDraftPaneReuse } from "./useDraftPaneReuse";
import { workspaceSubscribedThreadIdsByExecutor } from "./resourceSubscriptions";
import { removeWorkspacePanes } from "./paneRemoval";
import { currentKodexRoute } from "../shell/browserRouting";

type WorkspaceLiveEventHandler = (event: EventEnvelope) => void;
export type ThreadPaneTimelineAction =
  | { executorId: string; kind: "refresh_snapshot"; threadId?: string }
  | {
      clientRequestId: string;
      executorId: string;
      kind: "optimistic_user_started";
      skillMentions: TimelineSkillMention[];
      text: string;
      threadId: string;
    }
  | { clientRequestId: string; executorId: string; kind: "optimistic_user_sent" }
  | { clientRequestId: string; executorId: string; kind: "optimistic_user_removed" };
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
type WorkspacePaneCloseOptions = { nextActivePaneId?: string | null };
type WorkspacePaneFocusOptions = { pulse?: boolean };
type WorkspaceTerminalOpenOptions = WorkspacePaneOpenOptions & Pick<CreateTerminalSession, "command" | "cwd" | "projectId">;

type WorkspaceProviderProps = {
  approvals?: Approval[];
  children: ReactNode;
  errorMessage?: string | null;
  isVisible?: boolean;
  imagePreviewUrlsByPath?: Record<string, string>;
  imagePreviewUrlsByExecutor?: Record<string, Record<string, string>>;
  onApprovalDecision?: (approval: Approval, decision: ApprovalResponse) => void;
  onFocusThreadPane?: (threadId: string) => void;
  onImageOpen?: (image: ImageLightboxImage) => void;
  onLiveEvent?: (event: EventEnvelope, executorId: string) => void;
  onMarkdownOpen?: (executorId: string, threadId: string, request: MarkdownPreviewRequest) => void;
  onComposerTextDraftPresenceChange?: (present: boolean) => void;
  onShowMobileSidebar?: () => void;
  onThreadArchived?: (threadId: string) => void;
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
  threadProjectIdsById?: Record<string, string>;
  threadSummariesById?: Record<string, ThreadSummary>;
  threadActions?: WorkspaceThreadActions;
};

type WorkspaceContextValue = {
  approvals: Approval[];
  closePane: (paneId: string, dockviewLayout: unknown, options?: WorkspacePaneCloseOptions) => void;
  defaultExecutorId: string;
  duplicatePane: (paneId: string) => void;
  errorMessage: string | null;
  focusPane: (paneId: string | null, options?: WorkspacePaneFocusOptions) => void;
  focusPulseByPaneId: Record<string, number>;
  imagePreviewUrlsByPath: Record<string, string>;
  imagePreviewUrlsByExecutor: Record<string, Record<string, string>>;
  isLoading: boolean;
  onApprovalDecision: (approval: Approval, decision: ApprovalResponse) => void;
  onImageOpen: (image: ImageLightboxImage) => void;
  onMarkdownOpen: (executorId: string, threadId: string, request: MarkdownPreviewRequest) => void;
  onShowMobileSidebar: () => void;
  handleThreadArchived: (executorId: string, threadId: string) => void;
  onThreadSnapshotLoadFailed: (threadId: string) => void;
  onThreadSnapshotLoaded: (thread: ThreadSummary) => void;
  onVisiblePaneIdsChange: (paneIds: string[]) => void;
  visiblePaneIds: string[];
  openDraftThreadPane: (projectId?: string | null, options?: WorkspacePaneOpenOptions) => Promise<void>;
  openAppSurfacePane: (threadId: string, title?: string | null, options?: WorkspacePaneOpenOptions) => Promise<void>;
  openNewTerminalPane: (options?: WorkspaceTerminalOpenOptions) => Promise<void>;
  openTerminalPane: (options?: WorkspaceTerminalOpenOptions) => Promise<void>;
  openThreadPane: (threadId: string, title?: string | null, options?: WorkspacePaneOpenOptions) => Promise<void>;
  paneHeaderAdornmentsById: Record<string, ReactNode>;
  paneHeaderActionsById: Record<string, ReactNode>;
  panePlacementHintsById: WorkspacePanePlacementHintsById;
  paneTabStatusById: Record<string, WorkspacePaneTabStatus>;
  paneThreadContextsById: Record<string, PaneThreadContext>;
  setPaneDraftDisposable: (paneId: string, disposable: boolean) => void;
  setPaneComposerTextDraft: (paneId: string, present: boolean) => void;
  setPaneThreadContext: (paneId: string, context: PaneThreadContext | null) => void;
  persistLayout: (dockviewLayout: unknown, activePaneId: string | null) => void;
  publishThreadPaneTimelineAction: (action: ThreadPaneTimelineAction) => void;
  renderThreadComposer?: (pane: WorkspacePane, state: Omit<ThreadComposerState, "publishThreadPaneTimelineAction">) => ReactNode;
  renderThreadPaneAside?: (pane: WorkspacePane, state: ThreadPaneChromeState) => ReactNode;
  renderThreadPaneHeaderActions?: (pane: WorkspacePane, state: ThreadPaneChromeState) => ReactNode;
  renderThreadPane?: (pane: WorkspacePane, fallback: ReactNode) => ReactNode;
  showDebugEvents: boolean;
  subscribeLiveEvent: (executorId: string, handler: WorkspaceLiveEventHandler) => () => void;
  subscribeThreadPaneTimelineAction: (handler: ThreadPaneTimelineActionHandler) => () => void;
  clearPanePlacementHints: (paneIds: string[]) => void;
  setPaneHeaderAdornment: (paneId: string, adornment: ReactNode | null) => void;
  setPaneHeaderActions: (paneId: string, actions: ReactNode | null) => void;
  setPaneTabStatus: (paneId: string, status: WorkspacePaneTabStatus | null) => void;
  threadProjectIdsById: Record<string, string>;
  threadSummariesById: Record<string, ThreadSummary>;
  threadActions: WorkspaceThreadActions;
  updatePane: (paneId: string, request: WorkspacePanePatch) => Promise<void>;
  workspace: WorkspaceModel;
  workspaceError: Error | null;
};

type WorkspaceThreadActions = {
  pinPending?: boolean;
  onArchiveThread?: (threadId: string) => void;
  onPinThread?: (threadId: string) => void;
  onRenameThread?: (threadId: string, name: string) => Promise<void>;
  onSetThreadNotificationsEnabled?: (threadId: string, enabled: boolean) => void;
  onUnpinThread?: (threadId: string) => void;
};

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);
const noopThreadSnapshot = () => undefined;
const noopPublishThreadPaneTimelineAction = () => undefined;
const noopSubscribeThreadPaneTimelineAction = () => () => undefined;

export function WorkspaceProvider({
  approvals = [],
  children,
  errorMessage = null,
  isVisible = true,
  imagePreviewUrlsByPath = {},
  imagePreviewUrlsByExecutor = {},
  onApprovalDecision = () => undefined,
  onFocusThreadPane,
  onImageOpen = () => undefined,
  onLiveEvent,
  onMarkdownOpen = () => undefined,
  onComposerTextDraftPresenceChange = () => undefined,
  onShowMobileSidebar = () => undefined,
  onThreadArchived = noopThreadSnapshot,
  onThreadSnapshotLoadFailed = noopThreadSnapshot,
  onThreadSnapshotLoaded = noopThreadSnapshot,
  onVisibleThreadIdsChange = () => undefined,
  paneStore: paneStoreOverride,
  publishThreadPaneTimelineAction = noopPublishThreadPaneTimelineAction,
  renderThreadComposer,
  renderThreadPaneAside,
  renderThreadPaneHeaderActions,
  renderThreadPane,
  showDebugEvents = false,
  subscribeThreadPaneTimelineAction = noopSubscribeThreadPaneTimelineAction,
  threadProjectIdsById = {},
  threadSummariesById = {},
  threadActions = {},
}: WorkspaceProviderProps) {
  const instanceStorage = useGatewayInstanceStorage();
  const executorConnection = useExecutorConnection();
  const executorRuntimes = useExecutorRuntimes();
  const availableExecutorIds = useAvailableExecutorIds();
  const defaultExecutorId = executorConnection?.executorId ?? LOCAL_EXECUTOR_ID;
  const validateInstance = useGatewayInstanceValidation();
  const handleStreamConnected = useGatewayStreamConnected();
  const paneStore = useMemo(
    () => paneStoreOverride ?? createBrowserWorkspacePaneStore(instanceStorage, defaultExecutorId),
    [defaultExecutorId, instanceStorage, paneStoreOverride],
  );
  const liveEventCursorByExecutorRef = useRef(new Map<string, number>());
  const liveEventHandlersByExecutorRef = useRef(new Map<string, Set<WorkspaceLiveEventHandler>>());
  const onLiveEventRef = useRef(onLiveEvent);
  const [paneHeaderAdornmentsById, setPaneHeaderAdornmentsById] = useState<Record<string, ReactNode>>({});
  const [paneHeaderActionsById, setPaneHeaderActionsById] = useState<Record<string, ReactNode>>({});
  const [panePlacementHintsById, setPanePlacementHintsById] = useState<WorkspacePanePlacementHintsById>({});
  const [paneTabStatusById, setPaneTabStatusById] = useState<Record<string, WorkspacePaneTabStatus>>({});
  const [focusPulseByPaneId, setFocusPulseByPaneId] = useState<Record<string, number>>({});
  const [visiblePaneIds, setVisiblePaneIds] = useState<string[]>([]);
  const [workspace, setWorkspace] = useState<WorkspaceModel>(() => ensureWorkspaceHasActivePane(paneStore.load()));
  const { isReusableDraft, setPaneDraftDisposable } = useDraftPaneReuse(workspace.panes);
  const [composerTextDraftPaneIds, setComposerTextDraftPaneIds] = useState<Set<string>>(() => new Set());
  const [workspaceError, setWorkspaceError] = useState<Error | null>(null);
  const nextFocusPulseRef = useRef(0);
  const appSurfacePresentationHandlerRef = useRef<(event: EventEnvelope, executorId: string) => void>(() => undefined);
  const workspaceRef = useRef(workspace);

  useEffect(() => {
    onLiveEventRef.current = onLiveEvent;
  }, [onLiveEvent]);

  const setPaneComposerTextDraft = useCallback((paneId: string, present: boolean) => {
    setComposerTextDraftPaneIds((current) => {
      if (current.has(paneId) === present) return current;
      const next = new Set(current);
      if (present) next.add(paneId);
      else next.delete(paneId);
      return next;
    });
  }, []);
  useEffect(() => {
    const paneIds = new Set(workspace.panes.map((pane) => pane.id));
    setComposerTextDraftPaneIds((current) => {
      const next = new Set([...current].filter((paneId) => paneIds.has(paneId)));
      return next.size === current.size ? current : next;
    });
  }, [workspace.panes]);
  const hasComposerTextDraft = composerTextDraftPaneIds.size > 0;
  useEffect(() => {
    onComposerTextDraftPresenceChange(hasComposerTextDraft);
  }, [hasComposerTextDraft, onComposerTextDraftPresenceChange]);
  useEffect(() => () => onComposerTextDraftPresenceChange(false), [onComposerTextDraftPresenceChange]);

  useEffect(() => {
    workspaceRef.current = workspace;
  }, [workspace]);

  useEffect(() => {
    const paneIds = new Set(workspace.panes.map((pane) => pane.id));
    setFocusPulseByPaneId((current) => {
      let changed = false;
      const next: Record<string, number> = {};
      for (const [paneId, token] of Object.entries(current)) {
        if (paneIds.has(paneId)) {
          next[paneId] = token;
        } else {
          changed = true;
        }
      }
      return changed ? next : current;
    });
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
    setPaneHeaderAdornmentsById((current) => {
      let changed = false;
      const next: Record<string, ReactNode> = {};
      for (const [paneId, adornment] of Object.entries(current)) {
        if (paneIds.has(paneId)) {
          next[paneId] = adornment;
        } else {
          changed = true;
        }
      }
      return changed ? next : current;
    });
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

  const activeFocusedThread = useMemo(() => {
    const activePane = workspace.activePaneId
      ? workspace.panes.find((pane) => pane.id === workspace.activePaneId) ?? null
      : null;
    return activePane?.kind === "thread" && activePane.target.mode === "existing"
      ? { executorId: activePane.target.executorId, threadId: activePane.target.threadId }
      : null;
  }, [workspace.activePaneId, workspace.panes]);

  useEffect(() => {
    if (activeFocusedThread?.executorId === defaultExecutorId) {
      onFocusThreadPane?.(activeFocusedThread.threadId);
    }
  }, [activeFocusedThread?.executorId, activeFocusedThread?.threadId, defaultExecutorId, onFocusThreadPane]);

  const onVisiblePaneIdsChange = useCallback((paneIds: string[]) => {
    setVisiblePaneIds((current) => (sameStringArray(current, paneIds) ? current : paneIds));
  }, []);

  const pulsePane = useCallback((paneId: string | null) => {
    if (!paneId) {
      return;
    }
    nextFocusPulseRef.current += 1;
    const token = nextFocusPulseRef.current;
    setFocusPulseByPaneId((current) => ({ ...current, [paneId]: token }));
  }, []);

  const closeThreadPanes = useCallback((executorId: string, threadId: string) => {
    setWorkspace((current) => removeWorkspacePanes(
      current,
      (pane) => pane.kind === "thread" && pane.target.mode === "existing" && pane.target.executorId === executorId && pane.target.threadId === threadId,
    ));
  }, []);

  const handleThreadArchived = useCallback((executorId: string, threadId: string) => {
    closeThreadPanes(executorId, threadId);
    if (executorId === defaultExecutorId) onThreadArchived(threadId);
  }, [closeThreadPanes, defaultExecutorId, onThreadArchived]);

  const exposedVisiblePaneIds = useMemo(() => isVisible ? visiblePaneIds : [], [isVisible, visiblePaneIds]);
  const visibleThreadIds = useMemo(
    () => visibleThreadIdsForPaneIds(
      workspace.panes.filter((pane) => pane.target.executorId === defaultExecutorId),
      exposedVisiblePaneIds,
    ),
    [defaultExecutorId, exposedVisiblePaneIds, workspace.panes],
  );

  useEffect(() => {
    onVisibleThreadIdsChange(visibleThreadIds);
  }, [onVisibleThreadIdsChange, visibleThreadIds]);

  const { includeDebugEvents, includeCommandOutputs, getOptions: getDeliveryOptions } = useThreadDeliveryPreferences();
  const deliveryStreamsRef = useRef(new Set<ReturnType<typeof createEventStreamClient>>());
  const subscribedThreadIdsByExecutor = useMemo(() => workspaceSubscribedThreadIdsByExecutor(workspace.panes), [workspace.panes]);
  const subscribedThreadIdsKey = Array.from(subscribedThreadIdsByExecutor, ([executorId, threadIds]) => `${executorId}\n${threadIds.join("\n")}`).join("\n\n");

  useEffect(() => {
    const clients: ReturnType<typeof createEventStreamClient>[] = [];
    for (const [executorId, threadIds] of subscribedThreadIdsByExecutor) {
      const runtime = executorRuntimes?.get(executorId);
      const runtimeAvailable = availableExecutorIds?.has(executorId) ?? true;
      const connection = executorRuntimes
        ? runtimeAvailable ? runtime?.connection : undefined
        : executorConnection?.executorId === executorId ? executorConnection : undefined;
      if (!connection && executorRuntimes) continue;
      const beforeConnect = runtime
        ? async () => {
            try {
              const capabilities = await runtime.api.getCapabilities();
              return capabilities.gateway.instanceId === runtime.connection.instanceId;
            } catch {
              return false;
            }
          }
        : validateInstance;
      const client = createEventStreamClient({
        beforeConnect,
        connection,
        cursor: liveEventCursorByExecutorRef.current.get(executorId),
        includeGlobal: true,
        ...getDeliveryOptions(),
        threadIds,
        onStatusChange: (status, reason) => {
          if (status === "connected" && reason !== "delivery_options") {
            if (runtime) void runtime.queryClient.invalidateQueries();
            else handleStreamConnected?.();
            publishThreadPaneTimelineAction({ executorId, kind: "refresh_snapshot" });
          }
        },
        onEvent: (event) => {
          recordLiveEvent("global", event);
          liveEventCursorByExecutorRef.current.set(
            executorId,
            Math.max(liveEventCursorByExecutorRef.current.get(executorId) ?? 0, event.seq),
          );
          onLiveEventRef.current?.(event, executorId);
          if (runtime && executorId !== defaultExecutorId) applyApprovalInvalidation(runtime.queryClient, event);
          for (const handler of liveEventHandlersByExecutorRef.current.get(executorId) ?? []) handler(event);
          appSurfacePresentationHandlerRef.current(event, executorId);
        },
      });
      clients.push(client);
      client.connect();
    }
    for (const client of clients) deliveryStreamsRef.current.add(client);
    return () => {
      for (const client of clients) {
        deliveryStreamsRef.current.delete(client);
        client.close();
      }
    };
  }, [availableExecutorIds, defaultExecutorId, executorConnection, executorRuntimes, getDeliveryOptions, handleStreamConnected, publishThreadPaneTimelineAction, subscribedThreadIdsKey, validateInstance]);

  useEffect(() => {
    for (const client of deliveryStreamsRef.current) {
      client.updateDeliveryOptions({ includeDebugEvents, includeCommandOutputs });
    }
  }, [includeDebugEvents, includeCommandOutputs]);

  const { paneThreadContextsById, setPaneThreadContext } = usePaneThreadContexts(workspace.panes);

  const subscribeLiveEvent = useCallback((executorId: string, handler: WorkspaceLiveEventHandler) => {
    const handlers = liveEventHandlersByExecutorRef.current.get(executorId) ?? new Set<WorkspaceLiveEventHandler>();
    handlers.add(handler);
    liveEventHandlersByExecutorRef.current.set(executorId, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) liveEventHandlersByExecutorRef.current.delete(executorId);
    };
  }, []);

  const setPaneHeaderAdornment = useCallback((paneId: string, adornment: ReactNode | null) => {
    setPaneHeaderAdornmentsById((current) => {
      if (adornment === null) {
        if (!Object.prototype.hasOwnProperty.call(current, paneId)) {
          return current;
        }
        const { [paneId]: _removed, ...rest } = current;
        return rest;
      }
      if (current[paneId] === adornment) {
        return current;
      }
      return {
        ...current,
        [paneId]: adornment,
      };
    });
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

  const focusPane = useCallback((paneId: string | null, options: WorkspacePaneFocusOptions = {}) => {
    if (options.pulse) {
      pulsePane(paneId);
    }
    setWorkspace((current) => {
      if (current.activePaneId === paneId) {
        return current;
      }
      return ensureWorkspaceHasActivePane({
        ...current,
        activePaneId: paneId,
      });
    });
  }, [pulsePane]);

  const closePane = useCallback((paneId: string, dockviewLayout: unknown, options: WorkspacePaneCloseOptions = {}) => {
    setWorkspace((current) => removeWorkspacePanes(
      current,
      (pane) => pane.id === paneId,
      { dockviewLayout, nextActivePaneId: options.nextActivePaneId },
    ));
  }, []);

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

  const appendPane = useCallback((
    pane: WorkspacePane,
    intent: WorkspacePanePlacementIntent,
    options: WorkspacePaneOpenOptions = {},
  ) => {
    recordPanePlacementHint(pane.id, intent, options);
    setWorkspace((current) => {
      const shouldActivate = options.activate !== false || !hasPaneId(current, current.activePaneId);
      return {
        ...current,
        activePaneId: shouldActivate ? pane.id : current.activePaneId,
        dockviewLayout: null,
        panes: [...current.panes, pane],
      };
    });
  }, [recordPanePlacementHint]);

  const focusPaneOrAppend = useCallback((
    pane: WorkspacePane,
    intent: WorkspacePanePlacementIntent,
    options: WorkspacePaneOpenOptions = {},
    findExistingPane: (panes: WorkspacePane[]) => WorkspacePane | null = (panes) => findPaneByIdentity(panes, pane),
  ) => {
    if (options.duplicate) {
      appendPane(pane, intent, options);
      return;
    }
    const shouldActivate = options.activate !== false;
    setWorkspace((current) => {
      const existing = findExistingPane(current.panes);
      if (existing) {
        if (shouldActivate) {
          pulsePane(existing.id);
        }
        const nextPanes = pane.title && !existing.title
          ? current.panes.map((candidate) =>
              candidate.id === existing.id ? ({ ...candidate, title: pane.title } as WorkspacePane) : candidate,
            )
          : current.panes;
        if ((!shouldActivate || current.activePaneId === existing.id) && nextPanes === current.panes) {
          return current;
        }
        return {
          ...current,
          panes: nextPanes,
          activePaneId: shouldActivate ? existing.id : current.activePaneId,
        };
      }

      const solePane = current.panes.length === 1 ? current.panes[0] : null;
      if (intent === "thread" && !options.placement && solePane && isReusableDraft(solePane)) {
        if (shouldActivate) pulsePane(solePane.id);
        return { ...current, panes: [{ ...pane, id: solePane.id }] };
      }
      recordPanePlacementHint(pane.id, intent, options);
      return {
        ...current,
        activePaneId: shouldActivate || !hasPaneId(current, current.activePaneId) ? pane.id : current.activePaneId,
        dockviewLayout: null,
        panes: [...current.panes, pane],
      };
    });
  }, [appendPane, isReusableDraft, pulsePane, recordPanePlacementHint]);

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
      const executorId = options.executorId ?? defaultExecutorId;
      const pane: WorkspacePane = {
        id: createPaneId("thread"),
        kind: "thread",
        target: { executorId, mode: "existing", threadId },
        title: title ?? null,
      };
      focusPaneOrAppend(pane, options.duplicate ? "duplicate" : "thread", options);
    },
    [defaultExecutorId, focusPaneOrAppend],
  );

  useEffect(() => {
    const applyFederatedRoute = () => {
      const route = currentKodexRoute();
      if (!route.executorId || route.executorId === defaultExecutorId || !route.threadId) return;
      if (!executorRuntimes) return;
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      void openThreadPane(route.threadId, null, { executorId: route.executorId });
    };
    applyFederatedRoute();
    window.addEventListener("popstate", applyFederatedRoute);
    return () => window.removeEventListener("popstate", applyFederatedRoute);
  }, [availableExecutorIds, defaultExecutorId, executorRuntimes, openThreadPane]);

  const openDraftThreadPane = useCallback(
    async (projectId?: string | null, options: WorkspacePaneOpenOptions = {}) => {
      const executorId = options.executorId ?? defaultExecutorId;
      const pane = createDraftThreadPane(executorId, projectId);
      setWorkspace((current) => {
        const existing = !options.duplicate && !options.placement
          ? current.panes.find((candidate) => candidate.target.executorId === executorId && isReusableDraft(candidate))
          : undefined;
        if (!existing) {
          recordPanePlacementHint(pane.id, "draftThread", options);
          return {
            ...current,
            panes: [...current.panes, pane],
            activePaneId: options.activate === false && hasPaneId(current, current.activePaneId) ? current.activePaneId : pane.id,
            dockviewLayout: null,
          };
        }
        if (options.activate !== false) pulsePane(existing.id);
        return {
          ...current,
          activePaneId: options.activate === false ? current.activePaneId : existing.id,
          panes: current.panes.map((candidate) => candidate.id === existing.id ? { ...pane, id: existing.id } : candidate),
        };
      });
    },
    [defaultExecutorId, recordPanePlacementHint, pulsePane, isReusableDraft],
  );

  const openAppSurfacePane = useCallback(
    async (threadId: string, title?: string | null, options: WorkspacePaneOpenOptions = {}) => {
      const executorId = options.executorId ?? defaultExecutorId;
      if (!options.duplicate) {
        const existing = appSurfacePaneForThread(workspaceRef.current.panes, executorId, threadId);
        if (existing) {
          focusPane(existing.id);
          return;
        }
      }
      appendPane(
        {
          id: createPaneId("appSurface"),
          kind: "appSurface",
          target: { executorId, mode: "latest", threadId },
          title: title ?? "App Surface",
        },
        "appSurface",
        {
          ...options,
          activate: true,
          duplicate: true,
          placement: {
            ...options.placement,
            direction: options.placement?.direction ?? "within",
          },
        },
      );
    },
    [appendPane, defaultExecutorId, focusPane],
  );

  const openTerminalPane = useCallback(
    async (options: WorkspaceTerminalOpenOptions = {}) => {
      const executorId = options.executorId ?? defaultExecutorId;
      const pane: WorkspacePane = {
        id: createPaneId("terminal"),
        kind: "terminal",
        target: {
          executorId,
          command: options.command ?? null,
          cwd: options.cwd ?? null,
          ...(options.projectId ? { projectId: options.projectId } : {}),
          reuseRunning: !options.command && !options.cwd && !options.projectId,
        },
        title: "Terminal",
      };
      focusPaneOrAppend(pane, "terminal", options, terminalPaneForRequest({ ...options, executorId }));
    },
    [defaultExecutorId, focusPaneOrAppend],
  );

  const openNewTerminalPane = useCallback(
    async (options: WorkspaceTerminalOpenOptions = {}) => {
      appendPane(
        {
          id: createPaneId("terminal"),
          kind: "terminal",
          target: {
            executorId: options.executorId ?? defaultExecutorId,
            command: options.command ?? null,
            cwd: options.cwd ?? null,
            ...(options.projectId ? { projectId: options.projectId } : {}),
          },
          title: "Terminal",
        },
        "terminal",
        { ...options, duplicate: true },
      );
    },
    [appendPane, defaultExecutorId],
  );

  useEffect(() => {
    appSurfacePresentationHandlerRef.current = (event: EventEnvelope, executorId: string) => {
      const request = appSurfacePresentationRequestFromEvent(event);
      if (!request) {
        return;
      }
      void openAppSurfacePane(request.threadId, request.title ?? "App Surface", {
        activate: request.action === "focus",
        executorId,
      }).catch((error: unknown) => {
        console.error("Failed to apply app surface presentation request", error);
      });
    };
    return () => {
      appSurfacePresentationHandlerRef.current = () => undefined;
    };
  }, [openAppSurfacePane]);

  const archiveAwareThreadActions = useMemo<WorkspaceThreadActions>(
    () => ({
      ...threadActions,
      onArchiveThread: threadActions.onArchiveThread
        ? (threadId: string) => {
            flushSync(() => closeThreadPanes(defaultExecutorId, threadId));
            threadActions.onArchiveThread?.(threadId);
          }
        : undefined,
    }),
    [closeThreadPanes, defaultExecutorId, threadActions],
  );

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      approvals,
      closePane,
      defaultExecutorId,
      duplicatePane,
      errorMessage,
      focusPane,
      focusPulseByPaneId,
      imagePreviewUrlsByPath,
      imagePreviewUrlsByExecutor,
      isLoading: false,
      onApprovalDecision,
      onImageOpen,
      onMarkdownOpen,
      onShowMobileSidebar,
      handleThreadArchived,
      onThreadSnapshotLoadFailed,
      onThreadSnapshotLoaded,
      onVisiblePaneIdsChange,
      visiblePaneIds: exposedVisiblePaneIds,
      openDraftThreadPane,
      openAppSurfacePane,
      openNewTerminalPane,
      openTerminalPane,
      openThreadPane,
      paneHeaderAdornmentsById,
      paneHeaderActionsById,
      panePlacementHintsById,
      paneTabStatusById,
      paneThreadContextsById,
      setPaneThreadContext,
      setPaneDraftDisposable,
      setPaneComposerTextDraft,
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
      setPaneHeaderAdornment,
      setPaneHeaderActions,
      setPaneTabStatus,
      threadProjectIdsById,
      threadSummariesById,
      threadActions: archiveAwareThreadActions,
      updatePane,
      workspace,
      workspaceError,
    }),
    [
      approvals,
      closePane,
      defaultExecutorId,
      duplicatePane,
      errorMessage,
      focusPane,
      focusPulseByPaneId,
      imagePreviewUrlsByPath,
      imagePreviewUrlsByExecutor,
      onApprovalDecision,
      onImageOpen,
      onMarkdownOpen,
      onShowMobileSidebar,
      handleThreadArchived,
      onThreadSnapshotLoadFailed,
      onThreadSnapshotLoaded,
      onVisiblePaneIdsChange,
      exposedVisiblePaneIds,
      openDraftThreadPane,
      openAppSurfacePane,
      openNewTerminalPane,
      openTerminalPane,
      openThreadPane,
      paneHeaderAdornmentsById,
      paneHeaderActionsById,
      panePlacementHintsById,
      paneTabStatusById,
      paneThreadContextsById,
      setPaneThreadContext,
      setPaneDraftDisposable,
      setPaneComposerTextDraft,
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
      setPaneHeaderAdornment,
      setPaneHeaderActions,
      setPaneTabStatus,
      threadProjectIdsById,
      threadSummariesById,
      archiveAwareThreadActions,
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
    const { terminalId: _terminalId, reuseRunning: _reuseRunning, ...target } = pane.target;
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

function appSurfacePaneForThread(panes: WorkspacePane[], executorId: string, threadId: string): WorkspacePane | null {
  return panes.find((pane) => {
    if (pane.kind !== "appSurface") {
      return false;
    }
    const target = paneTargetRecord(pane);
    return pane.target.executorId === executorId && typeof target.threadId === "string" && target.threadId === threadId;
  }) ?? null;
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function hasPaneId(workspace: WorkspaceModel, paneId: string | null | undefined): boolean {
  return Boolean(paneId && workspace.panes.some((pane) => pane.id === paneId));
}

function appSurfacePresentationRequestFromEvent(event: EventEnvelope): {
  action: "focus" | "open";
  threadId: string;
  title: string | null;
} | null {
  if (event.kind !== "app_surface.presentation_requested" || !event.payload || typeof event.payload !== "object") {
    return null;
  }
  const payload = event.payload as { action?: unknown; threadId?: unknown; title?: unknown };
  const action = payload.action === "focus" || payload.action === "open" ? payload.action : null;
  const threadId = typeof payload.threadId === "string" ? payload.threadId : event.threadId;
  if (!action || !threadId) {
    return null;
  }
  return {
    action,
    threadId,
    title: typeof payload.title === "string" && payload.title.trim().length > 0 ? payload.title : null,
  };
}

function stableJsonKey(value: unknown): string {
  return JSON.stringify(value);
}

function findPaneByIdentity(panes: WorkspacePane[], pane: WorkspacePane): WorkspacePane | null {
  const targetKey = stableJsonKey(paneIdentity(pane));
  return panes.find((candidate) => stableJsonKey(paneIdentity(candidate)) === targetKey) ?? null;
}

function terminalPaneForRequest(options: WorkspaceTerminalOpenOptions): (panes: WorkspacePane[]) => WorkspacePane | null {
  const command = options.command ?? null;
  const cwd = options.cwd ?? null;
  const projectId = options.projectId ?? null;
  return (panes) => {
    const terminalPanes = [...panes].reverse().filter(
      (pane) => pane.kind === "terminal" && pane.target.executorId === options.executorId,
    );
    if (!command && !cwd && !projectId) {
      return terminalPanes[0] ?? null;
    }
    return terminalPanes.find((pane) => {
      const target = paneTargetRecord(pane);
      return (
        target.executorId === options.executorId &&
        (projectId ? target.projectId === projectId : !target.projectId) &&
        (!command || target.command === command) &&
        (!cwd || target.cwd === cwd)
      );
    }) ?? null;
  };
}

function paneIdentity(pane: WorkspacePane): unknown {
  if (pane.kind === "thread" && pane.target.mode === "draft") {
    return {
      kind: pane.kind,
      target: {
        executorId: pane.target.executorId,
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
