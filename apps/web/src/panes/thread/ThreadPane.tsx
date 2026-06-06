import { ActionIcon, Badge, Box, Button, Group, Loader, Menu, Modal, Skeleton, Switch, Text, TextInput, Title } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, Archive, CopyPlus, MoreHorizontal, PanelLeftOpen, Pencil, Pin, PinOff, Sparkles } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type FormEvent, type ReactNode, type SetStateAction } from "react";

import type { EventEnvelope, ThreadSummary } from "../../api/client";
import { getThreadAppSurface, getThreadDetail, getThreadTimelinePage } from "../../api/client";
import { queryKeys } from "../../api/queryKeys";
import { recordReducerBatch } from "../../events/liveDiagnostics";
import { errorMessageFrom } from "../../shared/values";
import { applyTimelineEventBatch, coalesceTimelineEventBatch } from "../../timeline/batch";
import { idleTimelineEntry, type TimelineEntry } from "../../timeline/entry";
import {
  applyLiveTimelineUpdate,
  addOptimisticUserMessage,
  applyTimelineHistoryWindow,
  applyTimelineSnapshot,
  canApplyThreadViewItemDelta,
  createTimelineState,
  markOptimisticUserMessageSent,
  removeOptimisticUserMessage,
  setTimelineOlderHistoryLoading,
  type TimelineState,
} from "../../timeline/reducer";
import {
  isTransientThreadSnapshotLoadError,
  MATERIALIZING_THREAD_SNAPSHOT_RETRY_MS,
} from "../../timeline/snapshotRetry";
import { isCanonicalThreadViewRenderEvent, threadViewSummaryToThreadSummary } from "../../timeline/threadViewEvents";
import { useTimelineEventQueue } from "../../timeline/useTimelineEventQueue";
import { threadDisplayTitle } from "../../threads/helpers";
import type { WorkspacePaneComponentProps } from "../../workspace/paneTypes";
import { paneTargetRecord } from "../../workspace/paneTypes";
import { useWorkspace } from "../../workspace/WorkspaceProvider";
import { EmptyPanel } from "../../ui/EmptyPanel";

const TimelineView = lazy(() =>
  import("../../timeline/TimelineView").then((module) => ({ default: module.TimelineView })),
);

export function ThreadPane({ isActive, pane }: WorkspacePaneComponentProps) {
  const { errorMessage, onShowMobileSidebar, renderThreadComposer, renderThreadPane, setPaneHeaderActions, updatePane, workspace } = useWorkspace();
  const paneIsActive = isActive || workspace?.activePaneId === pane.id;
  const target = paneTargetRecord(pane);
  const draftPaneActions = useMemo(
    () =>
      target.mode === "existing" ? null : (
        <ActionIcon
          aria-label="Show sidebar"
          className="kodex-thread-sidebar-button"
          onClick={onShowMobileSidebar}
          size="sm"
          variant="subtle"
        >
          <PanelLeftOpen size={17} />
        </ActionIcon>
      ),
    [onShowMobileSidebar, target.mode],
  );
  useEffect(() => {
    if (target.mode === "existing") {
      return;
    }
    setPaneHeaderActions(pane.id, draftPaneActions);
    return () => setPaneHeaderActions(pane.id, null);
  }, [draftPaneActions, pane.id, setPaneHeaderActions, target.mode]);
  const materializeThreadPane = useCallback(
    (threadId: string, title?: string | null) => {
      void updatePane(pane.id, {
        target: { mode: "existing", threadId },
        title: title ?? pane.title ?? undefined,
      }).catch((error: unknown) => {
        console.error("Failed to materialize workspace draft pane", error);
      });
    },
    [pane.id, pane.title, updatePane],
  );
  const fallback =
    target.mode !== "existing" || typeof target.threadId !== "string" ? (
      <DraftThreadPane
        composer={renderThreadComposer?.(pane, {
          activeTurnId: null,
          isActive: paneIsActive,
          isReady: true,
          materializeThreadPane,
          selectedThreadPresent: false,
        })}
        errorMessage={paneIsActive ? errorMessage : null}
        isActive={paneIsActive}
      />
    ) : (
      <ExistingThreadPane isActive={paneIsActive} pane={pane} paneTitle={pane.title ?? null} threadId={target.threadId} />
    );
  return <>{renderThreadPane?.(pane, fallback) ?? fallback}</>;
}

function ExistingThreadPane({
  isActive,
  pane,
  paneTitle,
  threadId,
}: {
  isActive: boolean;
  pane: WorkspacePaneComponentProps["pane"];
  paneTitle: string | null;
  threadId: string;
}) {
  const {
    approvals,
    errorMessage: appErrorMessage,
    imagePreviewUrlsByPath,
    onImageOpen,
    onMarkdownOpen,
    onApprovalDecision,
    onShowMobileSidebar,
    onThreadSnapshotLoadFailed,
    onThreadSnapshotLoaded,
    openGeneratedUiPane,
    openThreadPane,
    renderThreadComposer,
    renderThreadPaneAside,
    renderThreadPaneHeaderActions,
    setPaneHeaderActions,
    showDebugEvents,
    subscribeLiveEvent,
    subscribeThreadPaneTimelineAction,
    threadSummariesById,
    threadActions,
    updatePane,
  } = useWorkspace();
  const seededThread = threadSummariesById[threadId] ?? null;
  const [entry, setEntry] = useState<TimelineEntry>(idleTimelineEntry);
  const [paneErrorMessage, setPaneErrorMessage] = useState<string | null>(null);
  const [scrollParentElement, setScrollParentElement] = useState<HTMLDivElement | null>(null);
  const [thread, setThread] = useState<ThreadSummary | null>(seededThread);
  const [timeline, setTimeline] = useState<TimelineState>(() => createTimelineState());
  const refreshInFlightRef = useRef(false);
  const refreshInFlightThreadIdRef = useRef<string | null>(null);
  const refreshQueuedRef = useRef(false);
  const refreshRequestIdRef = useRef(0);
  const latestPaneThreadRef = useRef<ThreadSummary | null>(seededThread);
  const latestThreadIdRef = useRef(threadId);
  const [renameModalOpen, setRenameModalOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renamePending, setRenamePending] = useState(false);
  const retrySnapshotTimerRef = useRef<number | null>(null);
  const appSurfaceQuery = useQuery({
    queryKey: queryKeys.appSurface(threadId),
    queryFn: () => getThreadAppSurface(threadId),
  });

  const clearRetrySnapshotTimer = useCallback(() => {
    if (retrySnapshotTimerRef.current !== null) {
      window.clearTimeout(retrySnapshotTimerRef.current);
      retrySnapshotTimerRef.current = null;
    }
  }, []);
  latestThreadIdRef.current = threadId;
  latestPaneThreadRef.current = thread;

  const refreshSnapshot = useCallback(async () => {
    if (refreshInFlightRef.current && refreshInFlightThreadIdRef.current === threadId) {
      refreshQueuedRef.current = true;
      return;
    }
    refreshInFlightRef.current = true;
    refreshInFlightThreadIdRef.current = threadId;
    const requestId = refreshRequestIdRef.current + 1;
    refreshRequestIdRef.current = requestId;
    const requestThreadId = threadId;
    setEntry((current) =>
      current.threadId === threadId && current.phase === "streamingLive"
        ? { phase: "refreshingSnapshot", threadId }
        : { phase: "loadingSnapshot", threadId },
    );
    try {
      const snapshot = await getThreadDetail(threadId);
      if (requestId !== refreshRequestIdRef.current || requestThreadId !== latestThreadIdRef.current) {
        return;
      }
      const nextThread = threadViewSummaryToThreadSummary(snapshot.thread);
      setTimeline((current) => applyTimelineSnapshot(current, snapshot));
      const mergedThread = mergePaneThreadSummary(latestPaneThreadRef.current, nextThread);
      setThread((current) => mergePaneThreadSummary(current, nextThread));
      onThreadSnapshotLoaded(mergedThread);
      void updatePane(pane.id, { title: threadDisplayTitle(mergedThread) }).catch((error: unknown) => {
        console.error("Failed to update workspace thread pane title", error);
      });
      setEntry({ phase: "streamingLive", threadId });
      setPaneErrorMessage(null);
    } catch (error) {
      if (requestId !== refreshRequestIdRef.current || requestThreadId !== latestThreadIdRef.current) {
        return;
      }
      if (isTransientThreadSnapshotLoadError(error)) {
        clearRetrySnapshotTimer();
        setEntry({ phase: "loadingSnapshot", threadId });
        setPaneErrorMessage(null);
        retrySnapshotTimerRef.current = window.setTimeout(() => {
          retrySnapshotTimerRef.current = null;
          void refreshSnapshot();
        }, MATERIALIZING_THREAD_SNAPSHOT_RETRY_MS);
        return;
      }
      setEntry({ phase: "error", threadId });
      setPaneErrorMessage(errorMessageFrom(error));
      onThreadSnapshotLoadFailed(threadId);
    } finally {
      if (refreshInFlightThreadIdRef.current !== requestThreadId) {
        return;
      }
      refreshInFlightRef.current = false;
      refreshInFlightThreadIdRef.current = null;
      if (requestId === refreshRequestIdRef.current && refreshQueuedRef.current) {
        refreshQueuedRef.current = false;
        void refreshSnapshot();
      }
    }
  }, [clearRetrySnapshotTimer, onThreadSnapshotLoadFailed, onThreadSnapshotLoaded, pane.id, threadId, updatePane]);

  function reduceQueuedPaneTimelineEvents(current: TimelineState, events: EventEnvelope[]) {
    if (events.length === 0) {
      return current;
    }
    const startedAt = typeof performance !== "undefined" ? performance.now() : 0;
    let shouldRefresh = false;
    let validationState = current;
    const coalescedEvents = coalesceTimelineEventBatch(events);
    for (const event of coalescedEvents) {
      if (!canApplyThreadViewItemDelta(validationState, event)) {
        shouldRefresh = true;
        break;
      }
      validationState = applyLiveTimelineUpdate(validationState, event);
    }
    const next = applyTimelineEventBatch(current, coalescedEvents);
    const finishedAt = typeof performance !== "undefined" ? performance.now() : startedAt;
    recordReducerBatch(events.length, finishedAt - startedAt);
    if (shouldRefresh) {
      void refreshSnapshot();
    }
    return next;
  }

  const { cancelQueuedTimelineEvents, enqueueTimelineEvent } = useTimelineEventQueue({
    reduceEvents: reduceQueuedPaneTimelineEvents,
    setTimeline,
  });

  useEffect(() => {
    clearRetrySnapshotTimer();
    cancelQueuedTimelineEvents();
    setTimeline(createTimelineState());
    setEntry({ phase: "loadingSnapshot", threadId });
    setThread(seededThread);
    setPaneErrorMessage(null);
    void refreshSnapshot();
  }, [cancelQueuedTimelineEvents, clearRetrySnapshotTimer, refreshSnapshot, threadId]);

  useEffect(() => {
    if (!seededThread) {
      return;
    }
    setThread((current) => mergePaneThreadSummary(current, seededThread));
  }, [seededThread]);

  useEffect(() => () => clearRetrySnapshotTimer(), [clearRetrySnapshotTimer]);

  useEffect(() => {
    return subscribeLiveEvent((event) => {
      if (!isThreadEventForPane(event, threadId)) {
        return;
      }
      if (event.kind === "thread_view.refresh_required") {
        cancelQueuedTimelineEvents();
        void refreshSnapshot();
        return;
      }
      if (event.kind === "thread.notifications_updated") {
        const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
          ? event.payload as Record<string, unknown>
          : {};
        setThread((current) =>
          current ? { ...current, notificationsEnabled: payload.notificationsEnabled !== false } : current,
        );
        return;
      }
      if (event.kind === "thread.pin_updated") {
        const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
          ? event.payload as Record<string, unknown>
          : {};
        const pinnedAt = typeof payload.pinnedAt === "string" ? payload.pinnedAt : null;
        setThread((current) => (current ? { ...current, pinnedAt } : current));
        return;
      }
      if (event.kind === "timeline.thread_metadata") {
        const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
          ? event.payload as Record<string, unknown>
          : {};
        const metadataThread = payload.thread && typeof payload.thread === "object" && !Array.isArray(payload.thread)
          ? payload.thread as ThreadSummary
          : null;
        if (metadataThread?.id === threadId) {
          setThread(metadataThread);
          void updatePane(pane.id, { title: threadDisplayTitle(metadataThread) }).catch((error: unknown) => {
            console.error("Failed to update workspace thread pane title", error);
          });
        }
        if ("gitInfo" in payload) {
          setThread((current) =>
            current ? { ...current, gitInfo: mergeGitInfoPatch(current.gitInfo, payload.gitInfo) } : current,
          );
        }
        const name = typeof payload.threadName === "string" ? payload.threadName : typeof payload.name === "string" ? payload.name : null;
        if (name) {
          setThread((current) => (current ? { ...current, name } : current));
          void updatePane(pane.id, { title: name }).catch((error: unknown) => {
            console.error("Failed to update workspace thread pane title", error);
          });
        }
        return;
      }
      if (event.kind === "thread_view.patch" && shouldRefreshForLifecyclePatch(event)) {
        void refreshSnapshot();
      }
      if (!isCanonicalThreadViewRenderEvent(event, { includeGatewayDiagnostics: true })) {
        return;
      }
      enqueueTimelineEvent(event);
    });
  }, [cancelQueuedTimelineEvents, enqueueTimelineEvent, pane.id, refreshSnapshot, subscribeLiveEvent, threadId, updatePane]);

  useEffect(() => {
    return subscribeThreadPaneTimelineAction((action) => {
      if (action.kind === "optimistic_user_started") {
        if (action.threadId !== threadId) {
          return;
        }
        setTimeline((current) =>
          addOptimisticUserMessage(current, {
            clientRequestId: action.clientRequestId,
            skillMentions: action.skillMentions,
            text: action.text,
            threadId,
          }),
        );
        return;
      }
      if (action.kind === "optimistic_user_sent") {
        setTimeline((current) => markOptimisticUserMessageSent(current, action.clientRequestId));
        return;
      }
      setTimeline((current) => removeOptimisticUserMessage(current, action.clientRequestId));
    });
  }, [subscribeThreadPaneTimelineAction, threadId]);

  const loadOlderHistory = useCallback(() => {
    const cursor = timeline.olderCursor;
    if (!cursor || timeline.isLoadingOlderHistory) {
      return;
    }
    setTimeline((current) => setTimelineOlderHistoryLoading(current, true));
    void getThreadTimelinePage(threadId, { cursor })
      .then((snapshot) => {
        setTimeline((current) => applyTimelineHistoryWindow(current, snapshot));
        const nextThread = threadViewSummaryToThreadSummary(snapshot.thread);
        setThread((current) => mergePaneThreadSummary(current, nextThread));
      })
      .catch((error) => {
        setTimeline((current) => setTimelineOlderHistoryLoading(current, false));
        setPaneErrorMessage(errorMessageFrom(error));
      });
  }, [threadId, timeline.isLoadingOlderHistory, timeline.olderCursor]);
  const threadApprovals = approvals.filter((approval) => approval.threadId === threadId);
  const isReady = entry.phase === "streamingLive" || entry.phase === "refreshingSnapshot";
  const isInitialSnapshotLoading = (entry.phase === "loadingSnapshot" || entry.phase === "refreshingSnapshot") && !thread;
  const isUnavailable = entry.phase === "error" && !thread;
  const title = isUnavailable ? "Thread not found or unavailable" : paneTitle ?? (thread ? threadDisplayTitle(thread) : threadId);
  const threadChromeState = thread ? { isActive, thread, threadId } : null;
  const paneAside = threadChromeState ? renderThreadPaneAside?.(pane, threadChromeState) : null;
  const appSurfaceSession = appSurfaceQuery.data ?? null;
  const paneHeaderActions = useMemo(
    () => {
      const customHeaderActions = threadChromeState ? renderThreadPaneHeaderActions?.(pane, threadChromeState) : null;
      return (
        <Group className="kodex-thread-pane-actions" gap={4} wrap="nowrap">
          <ActionIcon
            aria-label="Show sidebar"
            className="kodex-thread-sidebar-button"
            onClick={onShowMobileSidebar}
            size="sm"
            variant="subtle"
          >
            <PanelLeftOpen size={17} />
          </ActionIcon>
          {entry.phase === "loadingSnapshot" || entry.phase === "refreshingSnapshot" ? (
            <Badge leftSection={<Loader size={10} />} variant="light">
              Syncing
            </Badge>
          ) : null}
          {!isUnavailable ? (
            <>
              {customHeaderActions}
              <ActionIcon
                aria-label="Duplicate pane"
                onClick={() =>
                  void openThreadPane(threadId, title, {
                    duplicate: true,
                    placement: { sourcePaneId: pane.id },
                  })
                }
                size="sm"
                title="Duplicate pane"
                variant="subtle"
              >
                <CopyPlus size={16} />
              </ActionIcon>
              {appSurfaceSession ? (
                <ActionIcon
                  aria-label="Open generated UI"
                  onClick={() =>
                    void openGeneratedUiPane(threadId, `${title} UI`, {
                      placement: { sourcePaneId: pane.id },
                    })
                  }
                  size="sm"
                  title="Open generated UI"
                  variant="subtle"
                >
                  <Sparkles size={16} />
                </ActionIcon>
              ) : null}
              {thread ? (
                <ThreadActionsMenu
                  onArchiveThread={threadActions.onArchiveThread}
                  onPinThread={threadActions.onPinThread}
                  onRenameThread={() => setRenameModalOpen(true)}
                  onSetThread={setThread}
                  onSetThreadNotificationsEnabled={threadActions.onSetThreadNotificationsEnabled}
                  onUnpinThread={threadActions.onUnpinThread}
                  thread={thread}
                />
              ) : null}
            </>
          ) : null}
        </Group>
      );
    },
    [
      entry.phase,
      appSurfaceSession,
      isActive,
      isUnavailable,
      onShowMobileSidebar,
      openGeneratedUiPane,
      openThreadPane,
      pane,
      renderThreadPaneHeaderActions,
      thread,
      threadActions.onArchiveThread,
      threadActions.onPinThread,
      threadActions.onSetThreadNotificationsEnabled,
      threadActions.onUnpinThread,
      threadId,
      title,
    ],
  );

  useEffect(() => {
    setPaneHeaderActions(pane.id, paneHeaderActions);
    return () => setPaneHeaderActions(pane.id, null);
  }, [pane.id, paneHeaderActions, setPaneHeaderActions]);

  useEffect(() => {
    if (!renameModalOpen || !thread) {
      return;
    }
    setRenameValue(thread.name ?? "");
    setRenameError(null);
  }, [renameModalOpen, thread?.id]);

  function closeRenameModal() {
    if (renamePending) {
      return;
    }
    setRenameModalOpen(false);
    setRenameError(null);
  }

  async function handleRenameSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!thread || !threadActions.onRenameThread) {
      return;
    }
    const name = renameValue.trim();
    if (!name) {
      setRenameError("Thread name cannot be empty.");
      return;
    }
    setRenamePending(true);
    setRenameError(null);
    try {
      await threadActions.onRenameThread(thread.id, name);
      setThread((current) => (current ? { ...current, name } : current));
      void updatePane(pane.id, { title: name }).catch((error: unknown) => {
        console.error("Failed to update workspace thread pane title", error);
      });
      setRenameModalOpen(false);
    } catch (error) {
      setRenameError(errorMessageFrom(error));
    } finally {
      setRenamePending(false);
    }
  }

  return (
    <section className="kodex-thread-pane kodex-thread-pane-existing" data-workspace-pane-active={isActive ? "true" : undefined}>
      <Title className="kodex-thread-pane-accessible-title" order={3} size="h5" title={title}>
        {title}
      </Title>
      <Modal centered onClose={closeRenameModal} opened={renameModalOpen && thread !== null} title="Rename thread">
        <Box component="form" onSubmit={handleRenameSubmit}>
          <TextInput
            autoFocus
            data-autofocus
            description="Type a name and press Enter."
            disabled={renamePending}
            error={renameError}
            label="Thread name"
            onChange={(event) => {
              setRenameValue(event.currentTarget.value);
              if (renameError) {
                setRenameError(null);
              }
            }}
            placeholder={title}
            value={renameValue}
          />
          <Group justify="flex-end" mt="md">
            <Button color="gray" disabled={renamePending} onClick={closeRenameModal} type="button" variant="light">
              Cancel
            </Button>
            <Button loading={renamePending} type="submit">
              Rename
            </Button>
          </Group>
        </Box>
      </Modal>
      <div className="kodex-thread-pane-status">
        {isActive && appErrorMessage ? <ThreadPaneErrorMessage message={appErrorMessage} /> : null}
        {paneErrorMessage && !isUnavailable ? (
          <Badge className="kodex-thread-pane-error" color="red" variant="light">
            {paneErrorMessage}
          </Badge>
        ) : null}
      </div>
      {isUnavailable ? (
        <ThreadUnavailablePane onBrowseThreads={onShowMobileSidebar} />
      ) : (
        <Box className="kodex-thread-content" data-subagent-sidebar={paneAside ? "open" : "closed"}>
          <div
            className="kodex-thread-pane-scroll kodex-timeline-scroll"
            data-entry-phase={entry.phase}
            ref={setScrollParentElement}
          >
            {isInitialSnapshotLoading ? (
              <TimelineLoadingSkeleton />
            ) : (
              <Suspense fallback={<TimelineLoadingSkeleton />}>
                <TimelineView
                  approvals={threadApprovals}
                  imagePreviewUrlsByPath={imagePreviewUrlsByPath}
                  onApprovalDecision={onApprovalDecision}
                  onImageOpen={onImageOpen}
                  onLoadOlderHistory={loadOlderHistory}
                  onMarkdownOpen={onMarkdownOpen}
                  onReady={() => {}}
                  scrollParentElement={scrollParentElement}
                  showDebug={showDebugEvents}
                  threadId={threadId}
                  timeline={timeline}
                />
              </Suspense>
            )}
          </div>
          {paneAside}
        </Box>
      )}
      {!isUnavailable && renderThreadComposer?.(pane, {
        activeTurnId: timeline.activeTurnId,
        isActive,
        isReady,
        selectedThreadPresent: true,
        thread,
      })}
    </section>
  );
}

function mergePaneThreadSummary(current: ThreadSummary | null, next: ThreadSummary): ThreadSummary {
  if (!current || current.id !== next.id) {
    return next;
  }
  if (Object.prototype.hasOwnProperty.call(next, "gitInfo")) {
    return next;
  }
  return {
    ...next,
    gitInfo: current.gitInfo,
  };
}

function mergeGitInfoPatch(current: ThreadSummary["gitInfo"], patch: unknown): ThreadSummary["gitInfo"] {
  if (patch === null) {
    return null;
  }
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return current;
  }
  const patchRecord = patch as Record<string, unknown>;
  return {
    branch: Object.prototype.hasOwnProperty.call(patchRecord, "branch")
      ? stringOrNull(patchRecord.branch)
      : current?.branch ?? null,
    originUrl: Object.prototype.hasOwnProperty.call(patchRecord, "originUrl")
      ? stringOrNull(patchRecord.originUrl)
      : current?.originUrl ?? null,
    sha: Object.prototype.hasOwnProperty.call(patchRecord, "sha")
      ? stringOrNull(patchRecord.sha)
      : current?.sha ?? null,
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function ThreadActionsMenu({
  onArchiveThread,
  onPinThread,
  onRenameThread,
  onSetThread,
  onSetThreadNotificationsEnabled,
  onUnpinThread,
  thread,
}: {
  onArchiveThread?: (threadId: string) => void;
  onPinThread?: (threadId: string) => void;
  onRenameThread: () => void;
  onSetThread: Dispatch<SetStateAction<ThreadSummary | null>>;
  onSetThreadNotificationsEnabled?: (threadId: string, enabled: boolean) => void;
  onUnpinThread?: (threadId: string) => void;
  thread: ThreadSummary;
}) {
  const notificationsEnabled = thread.notificationsEnabled !== false;
  return (
    <Menu position="bottom-end" withinPortal>
      <Menu.Target>
        <ActionIcon aria-label="Thread actions" variant="subtle">
          <MoreHorizontal size={17} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown aria-label="Thread actions">
        <Menu.Item
          leftSection={thread.pinnedAt ? <PinOff size={14} /> : <Pin size={14} />}
          onClick={() => {
            if (thread.pinnedAt) {
              onUnpinThread?.(thread.id);
              onSetThread((current) => (current ? { ...current, pinnedAt: null } : current));
              return;
            }
            onPinThread?.(thread.id);
            onSetThread((current) =>
              current ? { ...current, pinnedAt: new Date().toISOString() } : current,
            );
          }}
        >
          {thread.pinnedAt ? "Unpin thread" : "Pin thread"}
        </Menu.Item>
        <Menu.Item leftSection={<Pencil size={14} />} onClick={onRenameThread}>
          Rename thread
        </Menu.Item>
        <Menu.Item
          aria-checked={notificationsEnabled}
          closeMenuOnClick={false}
          onClick={() => {
            const nextEnabled = !notificationsEnabled;
            onSetThreadNotificationsEnabled?.(thread.id, nextEnabled);
            onSetThread((current) =>
              current ? { ...current, notificationsEnabled: nextEnabled } : current,
            );
          }}
          rightSection={
            <Switch
              aria-hidden="true"
              checked={notificationsEnabled}
              readOnly
              size="xs"
              style={{ pointerEvents: "none" }}
              tabIndex={-1}
            />
          }
          role="menuitemcheckbox"
        >
          Notifications
        </Menu.Item>
        {onArchiveThread ? (
          <Menu.Item
            leftSection={<Archive size={14} />}
            onClick={() => {
              onArchiveThread(thread.id);
            }}
          >
            Archive thread
          </Menu.Item>
        ) : null}
      </Menu.Dropdown>
    </Menu>
  );
}

function ThreadUnavailablePane({ onBrowseThreads }: { onBrowseThreads: () => void }) {
  return (
    <Box className="kodex-thread-empty kodex-thread-column">
      <EmptyPanel
        icon={<AlertCircle size={22} />}
        title="Thread not found or unavailable"
        text="This thread could not be loaded. It may have been archived, deleted, or unavailable from this gateway."
      />
      <Group className="kodex-thread-empty-actions" justify="center" gap="xs" wrap="nowrap">
        <Button
          className="kodex-thread-empty-action"
          onClick={onBrowseThreads}
          size="compact-sm"
          type="button"
          variant="light"
        >
          Browse threads
        </Button>
      </Group>
    </Box>
  );
}

function TimelineLoadingSkeleton() {
  return (
    <Box
      aria-busy="true"
      aria-label="Loading thread timeline"
      className="kodex-timeline-loading kodex-thread-column"
      role="status"
    >
      <SkeletonUserBubble lines={["full", "short"]} />
      <Box aria-hidden="true" className="kodex-timeline-skeleton-divider" />
      <SkeletonAssistantBlock lines={["long", "medium", "short", "medium", "tiny"]} />
    </Box>
  );
}

function SkeletonUserBubble({ lines }: { lines: SkeletonLineWidth[] }) {
  return (
    <Box aria-hidden="true" className="kodex-timeline-skeleton-row kodex-timeline-skeleton-user">
      <Box className="kodex-timeline-skeleton-user-bubble">
        {lines.map((line, index) => (
          <Skeleton
            className="kodex-timeline-skeleton-user-line"
            data-line-width={line}
            key={`${line}-${index}`}
            radius="xl"
          />
        ))}
      </Box>
    </Box>
  );
}

function SkeletonAssistantBlock({ lines }: { lines: SkeletonLineWidth[] }) {
  return (
    <Box aria-hidden="true" className="kodex-timeline-skeleton-row kodex-timeline-skeleton-assistant">
      {lines.map((line, index) => (
        <Skeleton
          className="kodex-timeline-skeleton-assistant-line"
          data-line-width={line}
          key={`${line}-${index}`}
          radius="xl"
        />
      ))}
    </Box>
  );
}

type SkeletonLineWidth = "full" | "long" | "medium" | "short" | "tiny";

function DraftThreadPane({
  composer,
  errorMessage,
  isActive,
}: {
  composer?: ReactNode;
  errorMessage: string | null;
  isActive: boolean;
}) {
  return (
    <section className="kodex-thread-pane kodex-thread-pane-empty" data-workspace-pane-active={isActive ? "true" : undefined}>
      <Title className="kodex-thread-pane-accessible-title" order={3} size="h5">
        Draft thread
      </Title>
      <div className="kodex-thread-pane-empty-body">
        {errorMessage ? <ThreadPaneErrorMessage message={errorMessage} /> : null}
        {composer}
      </div>
    </section>
  );
}

function ThreadPaneErrorMessage({ message }: { message: string }) {
  return (
    <Badge
      className="kodex-thread-column kodex-thread-pane-error"
      color="red"
      data-tone="danger"
      leftSection={<AlertCircle size={12} />}
      role="alert"
      variant="light"
    >
      {message}
    </Badge>
  );
}

function isThreadEventForPane(event: EventEnvelope, threadId: string): boolean {
  return event.threadId === threadId || (event.threadId === null && event.kind.startsWith("workspace."));
}

function shouldRefreshForLifecyclePatch(event: EventEnvelope): boolean {
  if (event.kind !== "thread_view.patch") {
    return false;
  }
  const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? event.payload as Record<string, unknown>
    : {};
  return payload.scope === "lifecycle" && payload.activeTurnId === null && payload.liveState === "idle";
}
