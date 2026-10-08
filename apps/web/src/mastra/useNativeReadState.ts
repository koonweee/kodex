import { useEffect, useEffectEvent, useRef } from 'react';
import { mastraClient, type ChatSnapshot } from './client';
import { nativeReadWitness } from './nativeReadWitness';

type ReadSnapshot = Pick<ChatSnapshot, 'chat' | 'readState' | 'display' | 'messages'>;
export function useNativeReadState({ snapshot, isVisible, onRefresh, onError }: {
  snapshot: ReadSnapshot | null;
  isVisible: boolean;
  onRefresh: () => void;
  onError: (error: unknown) => void;
}) {
  const state = snapshot?.readState;
  const head = state?.head;
  const target = snapshot ? JSON.stringify([snapshot.chat.bindingId, snapshot.chat.id, state?.epoch]) : null;
  const key = target && head ? JSON.stringify([target, state?.revision, head.runId]) : null;
  const currentKey = useRef(key);
  currentKey.current = key;
  const generation = useRef(0);
  const attempted = useRef<string | null>(null);
  useEffect(() => {
    generation.current++;
    attempted.current = null;
    return () => { generation.current++; };
  }, [target]);
  const witness = nativeReadWitness(snapshot);
  const hasVisibleCompletion = witness.assistantMessageVisible || witness.notice !== null;
  const acknowledge = useEffectEvent(() => {
    if (!snapshot || !key || !state || !head || state.seen !== false || !hasVisibleCompletion
      || !isVisible || document.visibilityState !== 'visible' || attempted.current === key) return;
    attempted.current = key;
    const dispatchedGeneration = generation.current;
    const stillCurrent = () => generation.current === dispatchedGeneration && currentKey.current === key;
    // Only a displayed canonical native head can authorize this write. Responses
    // never update local read state; the shared native watches own convergence.
    void mastraClient.markChatSeen({ chatId: snapshot.chat.id, epoch: state.epoch, revision: state.revision, runId: head.runId })
      .then(reply => { if (stillCurrent() && reply.outcome === 'conflict') onRefresh(); })
      .catch((error: unknown) => {
        if (!stillCurrent()) return;
        if (attempted.current === key) attempted.current = null;
        onError(error);
      });
  });
  useEffect(() => { acknowledge(); }, [snapshot, isVisible, hasVisibleCompletion]);
  useEffect(() => {
    document.addEventListener('visibilitychange', acknowledge);
    return () => document.removeEventListener('visibilitychange', acknowledge);
  }, []);
}
