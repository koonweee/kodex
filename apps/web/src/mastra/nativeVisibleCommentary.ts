import { payloadRecord } from '../timeline/presentationShared';
import type { ChatSnapshot } from './client';

/** Current-request presentation scope, not a persisted or inferred native turn. */
export function nativeVisibleCommentary(messages: ChatSnapshot['messages'], isRunning: boolean): ReadonlySet<string> {
  if (!isRunning) return new Set();
  let start = 0;
  messages.forEach((message, index) => {
    const signal = payloadRecord(message.content.metadata?.signal);
    const human = message.role === 'user' || message.role === 'signal' && (signal?.type === 'user' || signal?.type === 'user-message');
    // A native interjection belongs to ongoing work; it must not hide text
    // already shown earlier in that work. Other inputs begin a fresh UI span.
    if (human && payloadRecord(signal?.attributes)?.delivery !== 'while-active') start = index + 1;
  });
  return new Set(messages.slice(start).filter(message => message.role === 'assistant').map(message => message.id));
}
