import { useCallback, useEffect, useRef, useState } from 'react';
import { mastraClient } from './client';

/** Only command progress is local. Catalog/chat watches own saved preferences. */
export function useNativeChatMetadata(epoch: string | null, onError: (error: unknown) => void) {
  const commands = useRef(new Set<AbortController>());
  const pinCommand = useRef<AbortController | null>(null);
  const currentEpoch = useRef(epoch);
  currentEpoch.current = epoch;
  const [pinState, setPinState] = useState<{ epoch: string | null; pending: boolean } | null>(null);
  useEffect(() => () => {
    for (const controller of commands.current) controller.abort();
    commands.current.clear();
    pinCommand.current = null;
  }, [epoch]);
  const run = useCallback((kind: 'pin' | 'notifications', request: (signal: AbortSignal) => Promise<unknown>) => {
    if (kind === 'pin' && pinCommand.current) return;
    const controller = new AbortController();
    commands.current.add(controller);
    if (kind === 'pin') { pinCommand.current = controller; setPinState({ epoch, pending: true }); }
    const current = () => !controller.signal.aborted && currentEpoch.current === epoch;
    void Promise.resolve().then(() => current() ? request(controller.signal) : undefined).catch(error => {
      if (current()) onError(error);
    }).finally(() => {
      commands.current.delete(controller);
      if (pinCommand.current === controller) pinCommand.current = null;
      if (kind === 'pin' && current()) setPinState({ epoch, pending: false });
    });
  }, [epoch, onError]);
  const pin = useCallback((chatId: string) => run('pin', signal => mastraClient.setChatPinned({ chatId, pinned: true }, { signal })), [run]);
  const unpin = useCallback((chatId: string) => run('pin', signal => mastraClient.setChatPinned({ chatId, pinned: false }, { signal })), [run]);
  const movePinned = useCallback((chatId: string, beforeChatId: string | null) => run('pin', signal => mastraClient.setChatPinned({ chatId, pinned: true, beforeChatId }, { signal })), [run]);
  const setNotifications = useCallback((chatId: string, enabled: boolean) => run('notifications', signal => mastraClient.setChatNotifications({ chatId, enabled }, { signal })), [run]);
  return { pin, unpin, movePinned, setNotifications, pinPending: pinState?.epoch === epoch && pinState.pending };
}
