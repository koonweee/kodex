import { PaneLayout } from "../../shared/PaneLayout";
import { threadIndicatorState } from "../../threads/ThreadStatusIndicator";
import { AsyncQuestionReplyProvider } from "../../composer/AsyncQuestionReplyProvider";
import { refreshUnreadBadge } from "../../notifications/unreadBadge";
import { useThreadReadState } from "../../threads/useThreadReadState";
import { mergeThreadReadState, preserveNewerThreadReadState } from "../../threads/readState";
import { threadReadUpdateFromEvent } from "../../threads/events";
import { mergeThreadSummaryMetadata } from "../../threads/summaryMetadata";
import { subagentsEventInvalidatesThread } from "../../threads/subagentsCache";
import { useThreadPaneTitle } from "./useThreadPaneTitle";
import { ThreadActionsMenu } from "./ThreadActionsMenu";
import { Badge, Box, Button, Group, Loader, Modal, Skeleton, TextInput, Title } from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Sparkles } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";

import type { EventEnvelope, ThreadRead, ThreadSummary } from "../../api/client";
import { attachThread, getThreadAppSurface, getThreadTimelinePage } from "../../api/client";
import { projectEventInvalidatesThread } from "../../projects/cache";
import { queryKeys } from "../../api/queryKeys";
import { recordReducerBatch } from "../../events/liveDiagnostics";
import { errorMessageFrom } from "../../shared/values";
import { applyTimelineEventBatch } from "../../timeline/batch";
import { idleTimelineEntry, type TimelineEntry } from "../../timeline/entry";
import {
  addOptimisticUserMessage,
  applyTimelineHistoryWindow,
  applyTimelineSnapshot,
  createTimelineState,
  markOptimisticUserMessageSent,
  removeOptimisticUserMessage,
  setTimelineOlderHistoryLoading,
  type TimelineState,
} from "../../timeline/reducer";
import { isCanonicalThreadViewRenderEvent, threadViewSummaryToThreadSummary } from "../../timeline/threadViewEvents";
import { useTimelineEventQueue } from "../../timeline/useTimelineEventQueue";
import { threadDisplayTitle } from "../../threads/helpers";
import type { WorkspacePaneComponentProps } from "../../workspace/paneTypes";
import { paneTargetRecord } from "../../workspace/paneTypes";
import { useWorkspace } from "../../workspace/WorkspaceProvider";
import { AdaptiveIconButton } from "../../ui/AdaptiveIconButton";
import { ThreadUnavailablePane } from "./ThreadUnavailablePane";

const TimelineView = lazy(() =>
  import("../../timeline/TimelineView").then((module) => ({ default: module.TimelineView })),
);

export function ThreadPane({ isActive, pane }: WorkspacePaneComponentProps) {
  const { errorMessage, renderThreadComposer, renderThreadPane, updatePane, workspace } = useWorkspace();
  const paneIsActive = isActive || workspace?.activePaneId === pane.id;
  const target = paneTargetRecord(pane);
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
    openAppSurfacePane,
    openThreadPane,
    renderThreadComposer,
    renderThreadPaneAside,
    renderThreadPaneHeaderActions,
    setPaneHeaderActions,
    setPaneHeaderAdornment,
    setPaneThreadContext,
    showDebugEvents,
    subscribeLiveEvent,
    subscribeThreadPaneTimelineAction,
    threadSummariesById,
    threadActions,
    visiblePaneIds,
    updatePane,
  } = useWorkspace();
  const queryClient = useQueryClient();
  const seededThread = threadSummariesById[threadId] ?? null;
  const [entry, setEntry] = useState<TimelineEntry>(idleTimelineEntry);
  const [paneErrorMessage, setPaneErrorMessage] = useState<string | null>(null);
  const [scrollParentElement, setScrollParentElement] = useState<HTMLDivElement | null>(null);
  const [timelineOverflowAbove, setTimelineOverflowAbove] = useState(false);
  const [timelineOverflowBelow, setTimelineOverflowBelow] = useState(false);
  const [thread, setThread] = useState<ThreadSummary | null>(seededThread);
  const [timeline, setTimeline] = useState<TimelineState>(() => createTimelineState());
  const snapshotControllerRef = useRef<AbortController | null>(null);
  const historyControllerRef = useRef<AbortController | null>(null);
  const refreshInFlightRef = useRef(false);
  const refreshInFlightThreadIdRef = useRef<string | null>(null);
  const refreshQueuedRef = useRef(false);
  const refreshRequestIdRef = useRef(0);
  const latestPaneThreadRef = useRef<ThreadSummary | null>(seededThread);
  const latestReadEventRef = useRef<ThreadRead | null>(null);
  const latestThreadIdRef = useRef(threadId);
  const [renameModalOpen, setRenameModalOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renamePending, setRenamePending] = useState(false);
  const appSurfaceQuery = useQuery({
    queryKey: queryKeys.appSurface(threadId),
    queryFn: ({ signal }) => getThreadAppSurface(threadId, signal),
  });

  useEffect(() => {
    setPaneThreadContext(pane.id, thread ? { id: thread.id, projectId: thread.projectId, cwd: thread.cwd, indicatorState: threadIndicatorState(thread) } : null);
  }, [pane.id, setPaneThreadContext, thread?.id, thread?.projectId, thread?.cwd, thread?.status, thread?.unreadCompletedAgentTurn]);

  latestThreadIdRef.current = threadId;
  latestPaneThreadRef.current = thread;

  const refreshSnapshot = useCallback(async (replaceInFlight = false) => {
    if (replaceInFlight) {
      snapshotControllerRef.current?.abort();
      refreshInFlightRef.current = false;
      refreshQueuedRef.current = false;
    }
    if (refreshInFlightRef.current && refreshInFlightThreadIdRef.current === threadId) {
      refreshQueuedRef.current = true;
      return;
    }
    historyControllerRef.current?.abort();
    historyControllerRef.current = null;
    setTimeline((current) => setTimelineOlderHistoryLoading(current, false));
    refreshInFlightRef.current = true;
    refreshInFlightThreadIdRef.current = threadId;
    const requestId = refreshRequestIdRef.current + 1;
    refreshRequestIdRef.current = requestId;
    const requestThreadId = threadId;
    const controller = new AbortController();
    snapshotControllerRef.current = controller;
    setEntry((current) =>
      current.threadId === threadId && (current.phase === "streamingLive" || current.phase === "refreshingSnapshot")
        ? { phase: "refreshingSnapshot", threadId }
        : { phase: "loadingSnapshot", threadId },
    );
    try {
      const snapshot = await attachThread(threadId, controller.signal);
      controller.signal.throwIfAborted();
      if (requestId !== refreshRequestIdRef.current || requestThreadId !== latestThreadIdRef.current) {
        return;
      }
      const summary = threadViewSummaryToThreadSummary(snapshot.thread);
      const read = latestReadEventRef.current;
      const nextThread = read?.threadId === threadId ? mergeThreadReadState(summary, read) : summary;
      setTimeline((current) => applyTimelineSnapshot(current, snapshot));
      const mergedThread = mergePaneThreadSummary(latestPaneThreadRef.current, nextThread);
      setThread((current) => mergePaneThreadSummary(current, nextThread));
      onThreadSnapshotLoaded(mergedThread);
      setEntry({ phase: "streamingLive", threadId });
      setPaneErrorMessage(null);
    } catch (error) {
      if (requestId !== refreshRequestIdRef.current || requestThreadId !== latestThreadIdRef.current) {
        return;
      }
      setEntry({ phase: "error", threadId });
      setPaneErrorMessage(errorMessageFrom(error));
      onThreadSnapshotLoadFailed(threadId);
    } finally {
      if (refreshInFlightThreadIdRef.current !== requestThreadId || requestId !== refreshRequestIdRef.current) {
        return;
      }
      refreshInFlightRef.current = false;
      refreshInFlightThreadIdRef.current = null;
      if (requestId === refreshRequestIdRef.current && refreshQueuedRef.current) {
        refreshQueuedRef.current = false;
        void refreshSnapshot();
      }
    }
  }, [onThreadSnapshotLoadFailed, onThreadSnapshotLoaded, threadId]);

  useThreadReadState({
    thread,
    turns: timeline.turns,
    isVisible: visiblePaneIds.includes(pane.id),
    onRead: (read) => {
      void refreshUnreadBadge(queryClient);
      if (read.threadId !== latestThreadIdRef.current) return;
      const current = latestPaneThreadRef.current;
      if (!current) return;
      const next = mergeThreadReadState(current, read);
      setThread((current) => current ? mergeThreadReadState(current, read) : current);
      onThreadSnapshotLoaded(next);
    },
    onRefresh: () => { void refreshSnapshot(true); },
    onError: (error) => setPaneErrorMessage(errorMessageFrom(error)),
  });

  function reduceQueuedPaneTimelineEvents(current: TimelineState, events: EventEnvelope[]) {
    if (events.length === 0) {
      return current;
    }
    const startedAt = typeof performance !== "undefined" ? performance.now() : 0;
    const next = applyTimelineEventBatch(current, events);
    const finishedAt = typeof performance !== "undefined" ? performance.now() : startedAt;
    recordReducerBatch(events.length, finishedAt - startedAt);
    return next;
  }

  const { cancelQueuedTimelineEvents, enqueueTimelineEvent } = useTimelineEventQueue({
    onSnapshotRequired: () => { void refreshSnapshot(); },
    reduceEvents: reduceQueuedPaneTimelineEvents,
    setTimeline,
    timeline,
  });

  useEffect(() => {
    cancelQueuedTimelineEvents();
    setTimeline(createTimelineState());
    setEntry({ phase: "loadingSnapshot", threadId });
    setThread(seededThread);
    setTimelineOverflowAbove(false);
    setTimelineOverflowBelow(false);
    setPaneErrorMessage(null);
    void refreshSnapshot();
  }, [cancelQueuedTimelineEvents, refreshSnapshot, threadId]);

  useEffect(() => {
    if (!seededThread) {
      return;
    }
    setThread((current) => {
      const next = mergePaneThreadSummary(current, seededThread);
      return current ? { ...next, parentThreadId: current.parentThreadId, canAcceptDirectInput: current.canAcceptDirectInput } : next;
    });
  }, [seededThread]);

  useEffect(() => () => {
    snapshotControllerRef.current?.abort();
    historyControllerRef.current?.abort();
    refreshRequestIdRef.current += 1;
    snapshotControllerRef.current = null;
    historyControllerRef.current = null;
    refreshInFlightRef.current = false;
    refreshInFlightThreadIdRef.current = null;
    refreshQueuedRef.current = false;
  }, []);

  useEffect(() => {
    return subscribeLiveEvent((event) => {
      if (event.kind === "thread.pins_updated" || subagentsEventInvalidatesThread(event, threadId) || projectEventInvalidatesThread(event, threadId)) {
        cancelQueuedTimelineEvents();
        void refreshSnapshot(true);
        return;
      }
      if (!isThreadEventForPane(event, threadId)) {
        return;
      }
      if (event.kind === "thread.summary_changed" || event.codexMethod === "thread/name/updated") {
        if (refreshInFlightRef.current && refreshInFlightThreadIdRef.current === threadId) {
          cancelQueuedTimelineEvents();
          void refreshSnapshot(true);
        }
        if (event.kind === "thread.summary_changed") return;
      }
      if (event.kind === "thread_view.refresh_required") {
        cancelQueuedTimelineEvents();
        void refreshSnapshot(true);
        return;
      }
      if (event.kind === "thread.read_updated") {
        const read = threadReadUpdateFromEvent(event);
        if (read && (!latestReadEventRef.current || read.threadId !== latestReadEventRef.current.threadId || read.readRevision > latestReadEventRef.current.readRevision)) {
          latestReadEventRef.current = read;
          setThread((current) => current ? mergeThreadReadState(current, read) : current);
          if (!read.readStateKnown) void refreshSnapshot(true);
        }
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

      if (event.kind === "timeline.thread_metadata") {
        const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
          ? event.payload as Record<string, unknown>
          : {};
        const metadataThread = payload.thread && typeof payload.thread === "object" && !Array.isArray(payload.thread)
          ? payload.thread as ThreadSummary
          : null;
        if (metadataThread?.id === threadId) {
          setThread((current) => current ? mergeThreadSummaryMetadata(current, metadataThread) : current);
        }
        if ("gitInfo" in payload) {
          setThread((current) =>
            current ? { ...current, gitInfo: mergeGitInfoPatch(current.gitInfo, payload.gitInfo) } : current,
          );
        }
        const name = typeof payload.threadName === "string" ? payload.threadName : typeof payload.name === "string" ? payload.name : null;
        if (name) {
          setThread((current) => (current ? { ...current, name } : current));
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
  }, [cancelQueuedTimelineEvents, enqueueTimelineEvent, refreshSnapshot, subscribeLiveEvent, threadId]);

  useEffect(() => {
    return subscribeThreadPaneTimelineAction((action) => {
      if (action.kind === "refresh_snapshot") {
        if (!action.threadId || action.threadId === threadId) {
          cancelQueuedTimelineEvents();
          void refreshSnapshot(true);
        }
        return;
      }
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
  }, [cancelQueuedTimelineEvents, refreshSnapshot, subscribeThreadPaneTimelineAction, threadId]);

  const loadOlderHistory = useCallback(() => {
    const cursor = timeline.olderCursor;
    if (!cursor || timeline.isLoadingOlderHistory) {
      return;
    }
    historyControllerRef.current?.abort();
    const controller = new AbortController();
    historyControllerRef.current = controller;
    const snapshotRequestId = refreshRequestIdRef.current;
    setTimeline((current) => setTimelineOlderHistoryLoading(current, true));
    void getThreadTimelinePage(threadId, { cursor, signal: controller.signal })
      .then((snapshot) => {
        if (controller.signal.aborted || snapshotRequestId !== refreshRequestIdRef.current || threadId !== latestThreadIdRef.current) return;
        setTimeline((current) => applyTimelineHistoryWindow(current, snapshot));
        const nextThread = threadViewSummaryToThreadSummary(snapshot.thread);
        setThread((current) => mergePaneThreadSummary(current, nextThread));
      })
      .catch((error) => {
        if (controller.signal.aborted || snapshotRequestId !== refreshRequestIdRef.current || threadId !== latestThreadIdRef.current) return;
        setTimeline((current) => setTimelineOlderHistoryLoading(current, false));
        setPaneErrorMessage(errorMessageFrom(error));
      })
      .finally(() => {
        if (historyControllerRef.current === controller) historyControllerRef.current = null;
      });
  }, [threadId, timeline.isLoadingOlderHistory, timeline.olderCursor]);
  const threadApprovals = approvals.filter((approval) => approval.threadId === threadId);
  const isReady = entry.phase === "streamingLive" || entry.phase === "refreshingSnapshot";
  const isInitialSnapshotLoading = (entry.phase === "loadingSnapshot" || entry.phase === "refreshingSnapshot") && !thread;
  const isUnavailable = entry.phase === "error" && !thread;
  const nativeTitle = thread ? threadDisplayTitle(thread) : null;
  useThreadPaneTitle(pane.id, pane.title, nativeTitle, updatePane);
  const title = isUnavailable ? "Thread not found or unavailable" : nativeTitle ?? paneTitle ?? threadId;
  const threadChromeState = thread ? { isActive, thread, threadId } : null;
  const paneAside = threadChromeState ? renderThreadPaneAside?.(pane, threadChromeState) : null;
  const appSurfaceSession = appSurfaceQuery.data ?? null;
  const isSnapshotSyncing = entry.phase === "loadingSnapshot" || entry.phase === "refreshingSnapshot";
  const paneHeaderAdornment = useMemo(
    () =>
      isSnapshotSyncing ? (
        <Loader
          aria-hidden="true"
          className="kodex-thread-pane-title-spinner"
          size={12}
        />
      ) : null,
    [isSnapshotSyncing],
  );
  const paneHeaderActions = useMemo(
    () => {
      const customHeaderActions = threadChromeState ? renderThreadPaneHeaderActions?.(pane, threadChromeState) : null;
      return (
        <Group className="kodex-thread-pane-actions" gap={4} wrap="nowrap">
          {!isUnavailable ? (
            <>
              {customHeaderActions}
              {appSurfaceSession ? (
                <AdaptiveIconButton
                  label="Open app surface"
                  onClick={() =>
                    void openAppSurfacePane(threadId, `${title} App Surface`, {
                      placement: { sourcePaneId: pane.id },
                    })
                  }
                >
                  <Sparkles />
                </AdaptiveIconButton>
              ) : null}
              <ThreadActionsMenu
                pinPending={threadActions.pinPending}
                onDuplicatePane={() =>
                  void openThreadPane(threadId, title, {
                    duplicate: true,
                    placement: { sourcePaneId: pane.id },
                  })
                }
                onArchiveThread={threadActions.onArchiveThread}
                onPinThread={threadActions.onPinThread}
                onRenameThread={() => setRenameModalOpen(true)}
                onSetThread={setThread}
                onSetThreadNotificationsEnabled={threadActions.onSetThreadNotificationsEnabled}
                onUnpinThread={threadActions.onUnpinThread}
                thread={thread}
                threadId={threadId}
              />
            </>
          ) : null}
        </Group>
      );
    },
    [
      appSurfaceSession,
      isActive,
      isUnavailable,
      openAppSurfacePane,
      openThreadPane,
      pane,
      renderThreadPaneHeaderActions,
      thread,
      threadActions.pinPending,
      threadActions.onArchiveThread,
      threadActions.onPinThread,
      threadActions.onSetThreadNotificationsEnabled,
      threadActions.onUnpinThread,
      threadId,
      title,
    ],
  );

  useEffect(() => {
    setPaneHeaderAdornment(pane.id, paneHeaderAdornment);
    return () => setPaneHeaderAdornment(pane.id, null);
  }, [pane.id, paneHeaderAdornment, setPaneHeaderAdornment]);

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
      setRenameModalOpen(false);
    } catch (error) {
      setRenameError(errorMessageFrom(error));
    } finally {
      setRenamePending(false);
    }
  }

  return (
    <PaneLayout component="section" className="kodex-thread-pane kodex-thread-pane-existing" data-workspace-pane-active={isActive ? "true" : undefined}>
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
        <ThreadUnavailablePane paneId={pane.id} onBrowseThreads={onShowMobileSidebar} />
      ) : (
        <Box className="kodex-thread-content" data-subagent-sidebar={paneAside ? "open" : "closed"}>
          <div
            className="kodex-thread-scroll-frame"
            data-overflow-above={timelineOverflowAbove ? "true" : undefined}
            data-overflow-below={timelineOverflowBelow ? "true" : undefined}
          >
            <div
              className="kodex-thread-pane-scroll kodex-timeline-scroll"
              data-entry-phase={entry.phase}
              ref={setScrollParentElement}
            >
              {isInitialSnapshotLoading ? (
                <TimelineLoadingSkeleton />
              ) : (
                <Suspense fallback={<TimelineLoadingSkeleton />}>
                  <AsyncQuestionReplyProvider key={threadId} threadId={threadId} enabled={isReady && thread?.canAcceptDirectInput !== false} items={timeline.items}>
                    <TimelineView
                      approvals={threadApprovals}
                      imagePreviewUrlsByPath={imagePreviewUrlsByPath}
                      onApprovalDecision={onApprovalDecision}
                      onImageOpen={onImageOpen}
                      onLoadOlderHistory={loadOlderHistory}
                      onMarkdownOpen={onMarkdownOpen}
                      onOverflowAboveChange={setTimelineOverflowAbove}
                      onOverflowBelowChange={setTimelineOverflowBelow}
                      onReady={() => {}}
                      scrollParentElement={scrollParentElement}
                      showDebug={showDebugEvents}
                      threadId={threadId}
                      timeline={timeline}
                    />
                  </AsyncQuestionReplyProvider>
                </Suspense>
              )}
            </div>
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
    </PaneLayout>
  );
}

function mergePaneThreadSummary(current: ThreadSummary | null, next: ThreadSummary): ThreadSummary {
  if (!current || current.id !== next.id) {
    return next;
  }
  if (Object.prototype.hasOwnProperty.call(next, "gitInfo")) {
    return preserveNewerThreadReadState(current, next);
  }
  return {
    ...preserveNewerThreadReadState(current, next),
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
    <PaneLayout component="section" className="kodex-thread-pane kodex-thread-pane-empty" data-workspace-pane-active={isActive ? "true" : undefined}>
      <Title className="kodex-thread-pane-accessible-title" order={3} size="h5">
        Draft thread
      </Title>
      <div className="kodex-thread-pane-empty-body">
        {errorMessage ? <ThreadPaneErrorMessage message={errorMessage} /> : null}
        {composer}
      </div>
    </PaneLayout>
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
