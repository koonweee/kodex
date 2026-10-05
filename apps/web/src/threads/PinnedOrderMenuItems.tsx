import { Menu } from "@mantine/core";
import { ArrowDown, ArrowUp } from "lucide-react";

export type PinnedThreadActions = {
  onMovePinnedThread?: (threadId: string, beforeThreadId: string | null) => void;
  pinPending?: boolean;
};

export function PinnedOrderMenuItems({ threadId, onMovePinnedThread, pinPending = false,
  previousThreadId, followingThreadId, canMoveDown,
}: PinnedThreadActions & {
  threadId: string;
  previousThreadId?: string;
  followingThreadId?: string | null;
  canMoveDown?: boolean;
}) {
  if (!onMovePinnedThread || canMoveDown === undefined) return null;
  return <>
    <Menu.Item disabled={pinPending || !previousThreadId} leftSection={<ArrowUp size={14} />} onClick={() => previousThreadId && onMovePinnedThread(threadId, previousThreadId)}>Move up</Menu.Item>
    <Menu.Item disabled={pinPending || !canMoveDown} leftSection={<ArrowDown size={14} />} onClick={() => onMovePinnedThread(threadId, followingThreadId ?? null)}>Move down</Menu.Item>
  </>;
}
