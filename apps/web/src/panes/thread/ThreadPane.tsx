import { ActionIcon, Badge, Box, Button, Group, Loader, Modal, Skeleton, Switch, Text, TextInput, Title } from "@mantine/core";
import { AlertCircle, Archive, CopyPlus, MoreHorizontal, PanelLeftOpen, PanelRightOpen, Pencil, Pin, PinOff } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type Dispatch, type FormEvent, type ReactNode, type SetStateAction } from "react";

import type { EventEnvelope, ThreadSummary } from "../../api/client";
import { getThreadDetail, getThreadTimelinePage } from "../../api/client";
import { errorMessageFrom } from "../../shared/values";
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
import { threadDisplayTitle } from "../../threads/helpers";
import type { WorkspacePaneComponentProps } from "../../workspace/paneTypes";
import { paneTargetRecord } from "../../workspace/paneTypes";
import { useWorkspace } from "../../workspace/WorkspaceProvider";
import { EmptyPanel } from "../../ui/EmptyPanel";

const TimelineView = lazy(() =>
  import("../../timeline/TimelineView").then((module) => ({ default: module.TimelineView })),
);

export function ThreadPane({ isActive, pane }: WorkspacePaneComponentProps) {
  const { errorMessage, onShowMobileSidebar, renderThreadComposer, renderThreadPane, updatePane, workspace } = useWorkspace();
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
        onShowMobileSidebar={onShowMobileSidebar}
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
    showDebugEvents,
    subscribeLiveEvent,
    subscribeThreadPaneTimelineAction,
    threadActions,
    updatePane,
  } = useWorkspace();
  const [entry, setEntry] = useState<TimelineEntry>(idleTimelineEntry);
  const [paneErrorMessage, setPaneErrorMessage] = useState<string | null>(null);
  const [scrollParentElement, setScrollParentElement] = useState<HTMLDivElement | null>(null);
  const [thread, setThread] = useState<ThreadSummary | null>(null);
  const [timeline, setTimeline] = useState<TimelineState>(() => createTimelineState());
  const refreshInFlightRef = useRef(false);
  const refreshInFlightThreadIdRef = useRef<string | null>(null);
  const refreshQueuedRef = useRef(false);
  const refreshRequestIdRef = useRef(0);
  const latestThreadIdRef = useRef(threadId);
  const [renameModalOpen, setRenameModalOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renamePending, setRenamePending] = useState(false);
  const retrySnapshotTimerRef = useRef<number | null>(null);
  const wasActiveRef = useRef(isActive);

  const clearRetrySnapshotTimer = useCallback(() => {
    if (retrySnapshotTimerRef.current !== null) {
      window.clearTimeout(retrySnapshotTimerRef.current);
      retrySnapshotTimerRef.current = null;
    }
  }, []);
  latestThreadIdRef.current = threadId;

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
      setThread(nextThread);
      onThreadSnapshotLoaded(nextThread);
      void updatePane(pane.id, { title: threadDisplayTitle(nextThread) }).catch((error: unknown) => {
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

  useEffect(() => {
    clearRetrySnapshotTimer();
    setTimeline(createTimelineState());
    setEntry({ phase: "loadingSnapshot", threadId });
    setThread(null);
    setPaneErrorMessage(null);
    void refreshSnapshot();
  }, [clearRetrySnapshotTimer, refreshSnapshot, threadId]);

  useEffect(() => () => clearRetrySnapshotTimer(), [clearRetrySnapshotTimer]);

  useEffect(() => {
    const wasActive = wasActiveRef.current;
    wasActiveRef.current = isActive;
    if (isActive && !wasActive) {
      void refreshSnapshot();
    }
  }, [isActive, refreshSnapshot]);

  useEffect(() => {
    return subscribeLiveEvent((event) => {
      if (!isThreadEventForPane(event, threadId)) {
        return;
      }
      if (event.kind === "thread_view.refresh_required") {
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
      setTimeline((current) => {
        if (event.kind === "thread_view.item_delta" && !canApplyThreadViewItemDelta(current, event)) {
          void refreshSnapshot();
          return current;
        }
        return applyLiveTimelineUpdate(current, event);
      });
      setEntry({ phase: "streamingLive", threadId });
    });
  }, [pane.id, refreshSnapshot, subscribeLiveEvent, threadId, updatePane]);

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
        setThread(threadViewSummaryToThreadSummary(snapshot.thread));
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
  const headerActions = threadChromeState ? renderThreadPaneHeaderActions?.(pane, threadChromeState) : null;
  const paneAside = threadChromeState ? renderThreadPaneAside?.(pane, threadChromeState) : null;

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
    <section className="kodex-thread-pane" data-workspace-pane-active={isActive ? "true" : undefined}>
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
      <Group className="kodex-thread-pane-header kodex-thread-header" justify="space-between" wrap="nowrap">
        <Group gap="xs" wrap="nowrap" className="kodex-thread-heading">
          <ActionIcon
            aria-label="Show sidebar"
            className="kodex-thread-sidebar-button"
            onClick={onShowMobileSidebar}
            variant="subtle"
          >
            <PanelLeftOpen size={17} />
          </ActionIcon>
          <div className="kodex-thread-pane-title-block">
            <Title className="kodex-thread-title" order={3} size="h5" title={title}>
              {title}
            </Title>
          </div>
        </Group>
        {isUnavailable ? null : (
          <Group gap={4} wrap="nowrap">
            {entry.phase === "loadingSnapshot" || entry.phase === "refreshingSnapshot" ? (
              <Badge leftSection={<Loader size={10} />} variant="light">
                Syncing
              </Badge>
            ) : null}
            {isActive ? (
              <>
                {headerActions}
                <ActionIcon
                  aria-label="Duplicate pane"
                  onClick={() => void openThreadPane(threadId, title, { duplicate: true })}
                  size="sm"
                  title="Duplicate pane"
                  variant="subtle"
                >
                  <CopyPlus size={16} />
                </ActionIcon>
                <ActionIcon
                  aria-label="Open generated UI"
                  onClick={() => void openGeneratedUiPane(threadId, `${title} UI`)}
                  size="sm"
                  title="Open generated UI"
                  variant="subtle"
                >
                  <PanelRightOpen size={16} />
                </ActionIcon>
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
        )}
      </Group>
      {isActive && appErrorMessage ? <ThreadPaneErrorMessage message={appErrorMessage} /> : null}
      {paneErrorMessage && !isUnavailable ? (
        <Badge className="kodex-thread-pane-error" color="red" variant="light">
          {paneErrorMessage}
        </Badge>
      ) : null}
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
      })}
    </section>
  );
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
  const [opened, setOpened] = useState(false);
  const notificationsEnabled = thread.notificationsEnabled !== false;
  return (
    <Box className="kodex-thread-actions-menu">
      <ActionIcon
        aria-expanded={opened}
        aria-haspopup="menu"
        aria-label="Thread actions"
        onClick={() => setOpened((current) => !current)}
        variant="subtle"
      >
        <MoreHorizontal size={17} />
      </ActionIcon>
      {opened ? (
        <div className="kodex-thread-actions-dropdown" role="menu">
          <button
            className="kodex-thread-actions-item"
            onClick={() => {
            if (thread.pinnedAt) {
              onUnpinThread?.(thread.id);
              onSetThread((current) => (current ? { ...current, pinnedAt: null } : current));
              setOpened(false);
              return;
            }
            onPinThread?.(thread.id);
            onSetThread((current) =>
              current ? { ...current, pinnedAt: new Date().toISOString() } : current,
            );
            setOpened(false);
          }}
            role="menuitem"
            type="button"
          >
            {thread.pinnedAt ? <PinOff size={14} /> : <Pin size={14} />}
            <span>{thread.pinnedAt ? "Unpin thread" : "Pin thread"}</span>
          </button>
          <button
            className="kodex-thread-actions-item"
            onClick={() => {
              onRenameThread();
              setOpened(false);
            }}
            role="menuitem"
            type="button"
          >
            <Pencil size={14} />
            <span>Rename thread</span>
          </button>
          <button
            aria-checked={notificationsEnabled}
            className="kodex-thread-actions-item"
            onClick={() => {
            const nextEnabled = !notificationsEnabled;
            onSetThreadNotificationsEnabled?.(thread.id, nextEnabled);
            onSetThread((current) => (current ? { ...current, notificationsEnabled: nextEnabled } : current));
          }}
            role="menuitem"
            type="button"
          >
            <span>Notifications</span>
            <Switch
              aria-hidden="true"
              checked={notificationsEnabled}
              readOnly
              size="xs"
              style={{ pointerEvents: "none" }}
              tabIndex={-1}
            />
          </button>
          {onArchiveThread ? (
            <button
              className="kodex-thread-actions-item"
              onClick={() => {
                onArchiveThread(thread.id);
                setOpened(false);
              }}
              role="menuitem"
              type="button"
            >
              <Archive size={14} />
              <span>Archive thread</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </Box>
  );
}

function ThreadUnavailablePane({ onBrowseThreads }: { onBrowseThreads: () => void }) {
  return (
    <Box className="kodex-thread-empty kodex-main-column">
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
      className="kodex-timeline-loading kodex-main-column"
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
  onShowMobileSidebar,
}: {
  composer?: ReactNode;
  errorMessage: string | null;
  isActive: boolean;
  onShowMobileSidebar: () => void;
}) {
  return (
    <section className="kodex-thread-pane kodex-thread-pane-empty" data-workspace-pane-active={isActive ? "true" : undefined}>
      <Group className="kodex-thread-pane-header kodex-thread-header" justify="space-between" wrap="nowrap">
        <Group gap="xs" wrap="nowrap" className="kodex-thread-heading">
          <ActionIcon
            aria-label="Show sidebar"
            className="kodex-thread-sidebar-button"
            onClick={onShowMobileSidebar}
            variant="subtle"
          >
            <PanelLeftOpen size={17} />
          </ActionIcon>
          <Title className="kodex-thread-title" order={3} size="h5">
            Draft thread
          </Title>
        </Group>
      </Group>
      {errorMessage ? <ThreadPaneErrorMessage message={errorMessage} /> : null}
      <div className="kodex-thread-pane-empty-copy">
        <Text fw={650}>Draft thread</Text>
        <Text c="dimmed" size="sm">
          Send a message to start this thread.
        </Text>
      </div>
      {composer}
    </section>
  );
}

function ThreadPaneErrorMessage({ message }: { message: string }) {
  return (
    <Badge
      className="kodex-main-column kodex-thread-pane-error"
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
