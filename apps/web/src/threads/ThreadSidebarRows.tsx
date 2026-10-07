import { ThreadStatusIndicator, threadIndicatorState } from "./ThreadStatusIndicator";
import { Badge, Group, Menu, Stack, Text } from "@mantine/core";
import { Archive, MoreHorizontal, Pin, PinOff } from "lucide-react";
import { memo, useRef, type PointerEvent as ReactPointerEvent } from "react";
import type { Approval } from "../api/client";
import type { ThreadListEntry as ThreadSummary } from "../threads/viewTypes";
import { PinnedOrderMenuItems, type PinnedThreadActions } from "./PinnedOrderMenuItems";
import { threadDisplayTitle, threadNeedsApproval } from "./helpers";
import { SidebarIconButton } from "./SidebarIconButton";
import { SidebarRowFrame } from "./sidebarRows";
import "../styles/thread-sidebar-rows.css";

const SIDEBAR_TEXT = { newThread: "New thread", pinThread: "Pin thread", unpinThread: "Unpin thread", showMoreLoading: "Loading more", showLessThreads: "Show less", showMoreThreads: "Show more", showMoreError: "Could not load more threads" };
const VISIBLE_THREAD_LIMIT = 5;
type SidebarPaginationState = "idle" | "loading" | "error";
function threadDisplayTitleWithPending(thread: ThreadSummary, pending: Set<string>) { return pending.has(thread.id) ? SIDEBAR_TEXT.newThread : threadDisplayTitle(thread); }

export type ThreadListRowProps = PinnedThreadActions & {
  previousThreadId?: string;
  followingThreadId?: string | null;
  canMoveDown?: boolean;
  approvals: Approval[];
  isSelected: boolean;
  onArchiveThread: (threadId: string) => void;
  onPinThread: (threadId: string) => void;
  onSelectThread: (threadId: string) => void;
  onThreadActionHoverChange: (threadId: string | null) => void;
  onUnpinThread: (threadId: string) => void;
  pendingTitleThreadIds: Set<string>;
  showThreadArchiveAction: boolean;
  thread: ThreadSummary;
};

export const ThreadListRow = memo(function ThreadListRow({
  approvals,
  isSelected,
  onArchiveThread,
  onPinThread,
  onSelectThread,
  onThreadActionHoverChange,
  onUnpinThread,
  pendingTitleThreadIds,
  showThreadArchiveAction,
  thread, onMovePinnedThread, pinPending, previousThreadId, followingThreadId, canMoveDown,
}: ThreadListRowProps) {
  const needsApproval = threadNeedsApproval(thread, approvals);
  const indicatorState = threadIndicatorState(thread);
  const displayTitle = threadDisplayTitleWithPending(thread, pendingTitleThreadIds);
  const isPinned = thread.pinned;
  const pinLabel = isPinned ? SIDEBAR_TEXT.unpinThread : SIDEBAR_TEXT.pinThread;
  const focusPointerType = useRef<string | null>(null);

  function handleHoverPointerDown(event: ReactPointerEvent<HTMLElement>) {
    focusPointerType.current = event.pointerType;
  }

  function handleHoverPointerEnter(event: ReactPointerEvent<HTMLElement>) {
    if (event.pointerType === "mouse") {
      onThreadActionHoverChange(thread.id);
    }
  }

  function handleHoverPointerLeave(event: ReactPointerEvent<HTMLElement>) {
    if (event.pointerType === "mouse") {
      onThreadActionHoverChange(null);
    }
  }

  return (
    <SidebarRowFrame
      className="kodex-ui-selectable kodex-list-button kodex-thread-list-button"
      leadingContent={
        <SidebarIconButton
          className="kodex-thread-pin-button"
          data-pinned={isPinned ? "true" : undefined}
          density="compact"
          label={pinLabel}
          disabled={pinPending}
          onClick={(event) => {
            event.stopPropagation();
            if (isPinned) {
              onUnpinThread(thread.id);
            } else {
              onPinThread(thread.id);
            }
          }}
        >
          {isPinned ? (
            <>
              <Pin className="kodex-thread-pin-state-icon" />
              <PinOff className="kodex-thread-pin-action-icon" />
            </>
          ) : (
            <Pin />
          )}
        </SidebarIconButton>
      }
      rootProps={{
        "data-active": isSelected ? "true" : undefined,
        "data-pinned": isPinned ? "true" : undefined,
        "data-has-order-menu": onMovePinnedThread ? "true" : undefined,
        onBlur: (event) => {
          focusPointerType.current = null;
          if (!event.currentTarget.contains(event.relatedTarget)) {
            onThreadActionHoverChange(null);
          }
        },
        onFocus: () => {
          if (focusPointerType.current !== "touch" && focusPointerType.current !== "pen") {
            onThreadActionHoverChange(thread.id);
          }
        },
        onPointerDown: handleHoverPointerDown,
        onPointerEnter: handleHoverPointerEnter,
        onPointerLeave: handleHoverPointerLeave,
      }}
      trailingContent={
        <>
          {onMovePinnedThread ? <Menu position="bottom-end" withinPortal>
            <Menu.Target><SidebarIconButton density="compact" label={`Thread actions for ${displayTitle}`} tooltip={false}><MoreHorizontal /></SidebarIconButton></Menu.Target>
            <Menu.Dropdown>
              <PinnedOrderMenuItems threadId={thread.id} onMovePinnedThread={onMovePinnedThread} pinPending={pinPending} previousThreadId={previousThreadId} followingThreadId={followingThreadId} canMoveDown={canMoveDown} />
              <Menu.Item onClick={() => onArchiveThread(thread.id)}>Archive thread</Menu.Item>
            </Menu.Dropdown>
          </Menu> : null}
          {indicatorState && !showThreadArchiveAction ? (
            <ThreadStatusIndicator state={indicatorState} className="kodex-thread-status-slot" />
          ) : null}
          {showThreadArchiveAction ? (
            <SidebarIconButton
              className="kodex-thread-archive-button"
              density="compact"
              label={`Archive ${displayTitle}`}
              tooltip="Archive thread"
              onClick={() => onArchiveThread(thread.id)}
            >
              <Archive />
            </SidebarIconButton>
          ) : null}
        </>
      }
    >
      <button className="kodex-ui-button kodex-thread-select-button" onClick={() => onSelectThread(thread.id)} type="button">
        <Group
          align="flex-start"
          className="kodex-thread-list-row"
          data-has-sidecar={needsApproval ? "true" : undefined}
          gap="xs"
          justify="space-between"
          wrap="nowrap"
        >
          <Text
            className="kodex-thread-list-title"
            c={pendingTitleThreadIds.has(thread.id) ? "dimmed" : undefined}
            data-placeholder-title={pendingTitleThreadIds.has(thread.id) ? "true" : undefined}
            fw={400}
            size="xs"
            lineClamp={1}
          >
            {displayTitle}
          </Text>
          {needsApproval ? (
            <Badge className="kodex-thread-approval-badge" data-tone="warning" size="xs" variant="light">
              Needs approval
            </Badge>
          ) : null}
        </Group>
      </button>
    </SidebarRowFrame>
  );
}, areThreadListRowPropsEqual);

export function areThreadListRowPropsEqual(previous: ThreadListRowProps, next: ThreadListRowProps) {
  return (
    previous.onMovePinnedThread === next.onMovePinnedThread &&
    previous.pinPending === next.pinPending &&
    previous.previousThreadId === next.previousThreadId &&
    previous.followingThreadId === next.followingThreadId &&
    previous.canMoveDown === next.canMoveDown &&
    previous.approvals === next.approvals &&
    previous.isSelected === next.isSelected &&
    previous.onArchiveThread === next.onArchiveThread &&
    previous.onPinThread === next.onPinThread &&
    previous.onSelectThread === next.onSelectThread &&
    previous.onThreadActionHoverChange === next.onThreadActionHoverChange &&
    previous.onUnpinThread === next.onUnpinThread &&
    previous.pendingTitleThreadIds === next.pendingTitleThreadIds &&
    previous.showThreadArchiveAction === next.showThreadArchiveAction &&
    previous.thread === next.thread
  );
}

export function ThreadList({
  approvals,
  className,
  expanded,
  hasMore = false,
  hoveredThreadActionId,
  onArchiveThread,
  onPinThread,
  onSelectThread,
  onThreadActionHoverChange,
  onToggleExpanded,
  onUnpinThread,
  pendingTitleThreadIds,
  paginationState = "idle",
  selectedThreadId,
  threads, onMovePinnedThread, pinPending, pinnedOrder,
}: PinnedThreadActions & {
  pinnedOrder?: ThreadSummary[];
  approvals: Approval[];
  className: string;
  expanded: boolean;
  hasMore?: boolean;
  hoveredThreadActionId: string | null;
  onArchiveThread: (threadId: string) => void;
  onPinThread: (threadId: string) => void;
  onSelectThread: (threadId: string) => void;
  onThreadActionHoverChange: (threadId: string | null) => void;
  onToggleExpanded: () => void;
  onUnpinThread: (threadId: string) => void;
  pendingTitleThreadIds: Set<string>;
  paginationState?: SidebarPaginationState;
  selectedThreadId: string | null;
  threads: ThreadSummary[];
}) {
  const visibleThreads = expanded ? threads : threads.slice(0, VISIBLE_THREAD_LIMIT);
  const hasHiddenThreads = threads.length > VISIBLE_THREAD_LIMIT || hasMore;
  const toggleLabel =
    paginationState === "loading"
      ? SIDEBAR_TEXT.showMoreLoading
      : expanded && !hasMore
        ? SIDEBAR_TEXT.showLessThreads
        : SIDEBAR_TEXT.showMoreThreads;

  return (
    <Stack className={className} gap={6}>
      {visibleThreads.map((thread) => (
        <ThreadListRow
          onMovePinnedThread={onMovePinnedThread} pinPending={pinPending}
          previousThreadId={pinnedOrder?.[pinnedOrder.findIndex((row) => row.id === thread.id) - 1]?.id}
          followingThreadId={pinnedOrder ? pinnedOrder[pinnedOrder.findIndex((row) => row.id === thread.id) + 2]?.id ?? (hasMore ? undefined : null) : undefined}
          canMoveDown={pinnedOrder ? pinnedOrder.findIndex((row) => row.id === thread.id) < pinnedOrder.length - 1 && (pinnedOrder.findIndex((row) => row.id === thread.id) + 2 < pinnedOrder.length || !hasMore) : undefined}
          approvals={approvals}
          isSelected={thread.id === selectedThreadId}
          key={thread.id}
          onArchiveThread={onArchiveThread}
          onPinThread={onPinThread}
          onSelectThread={onSelectThread}
          onThreadActionHoverChange={onThreadActionHoverChange}
          onUnpinThread={onUnpinThread}
          pendingTitleThreadIds={pendingTitleThreadIds}
          showThreadArchiveAction={hoveredThreadActionId === thread.id}
          thread={thread}
        />
      ))}
      {hasHiddenThreads ? (
        <button
          className="kodex-ui-button kodex-thread-list-more-button"
          disabled={paginationState === "loading"}
          onClick={onToggleExpanded}
          type="button"
        >
          {toggleLabel}
        </button>
      ) : null}
      {paginationState === "error" ? (
        <Text c="red" role="alert" size="xs">
          {SIDEBAR_TEXT.showMoreError}
        </Text>
      ) : null}
    </Stack>
  );
}
