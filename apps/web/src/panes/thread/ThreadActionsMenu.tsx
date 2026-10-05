import { Menu, Switch } from "@mantine/core";
import { Archive, Copy, CopyPlus, MoreHorizontal, Pencil, Pin, PinOff } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import type { ThreadSummary } from "../../api/client";
import { AdaptiveIconButton } from "../../ui/AdaptiveIconButton";
import { copyTextToClipboard } from "../../shared/clipboard";

export function ThreadActionsMenu({
  onDuplicatePane,
  onArchiveThread,
  onPinThread,
  onRenameThread,
  onSetThread,
  onSetThreadNotificationsEnabled,
  onUnpinThread,
  thread,
  threadId, pinPending,
}: {
  pinPending?: boolean;
  onDuplicatePane: () => void;
  onArchiveThread?: (threadId: string) => void;
  onPinThread?: (threadId: string) => void;
  onRenameThread: () => void;
  onSetThread: Dispatch<SetStateAction<ThreadSummary | null>>;
  onSetThreadNotificationsEnabled?: (threadId: string, enabled: boolean) => void;
  onUnpinThread?: (threadId: string) => void;
  thread: ThreadSummary | null;
  threadId: string;
}) {
  const notificationsEnabled = thread?.notificationsEnabled !== false;
  return (
    <Menu position="bottom-end" withinPortal>
      <Menu.Target>
        <AdaptiveIconButton label="Thread actions" tooltip={false}>
          <MoreHorizontal />
        </AdaptiveIconButton>
      </Menu.Target>
      <Menu.Dropdown aria-label="Thread actions">
        <Menu.Item leftSection={<CopyPlus size={14} />} onClick={onDuplicatePane}>
          Duplicate pane
        </Menu.Item>
        {thread ? (
          <>
            <Menu.Item
              disabled={pinPending}
              leftSection={thread.pinned ? <PinOff size={14} /> : <Pin size={14} />}
              onClick={() => {
                if (thread.pinned) {
                  onUnpinThread?.(thread.id);
                  return;
                }
                onPinThread?.(thread.id);
              }}
            >
              {thread.pinned ? "Unpin thread" : "Pin thread"}
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
          </>
        ) : null}
        <Menu.Item leftSection={<Copy size={14} />} onClick={() => void copyTextToClipboard(threadId)}>
          Copy thread ID
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
