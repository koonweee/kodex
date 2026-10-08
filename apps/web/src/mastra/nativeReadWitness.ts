import type { ChatSnapshot } from './client';

type WitnessSnapshot = Pick<ChatSnapshot, 'readState' | 'display' | 'messages'>;
const terminalText = { complete: 'Run completed.', aborted: 'Run stopped.', error: 'The model run failed. Please try again.' };

// The canonical native head owns the outcome. The idle check only suppresses an
// old notice during newer work; neither idle state nor a user row creates a head.
export function nativeReadWitness(snapshot: WitnessSnapshot | null) {
  const head = snapshot?.readState?.head;
  if (!snapshot || !head) return { assistantMessageVisible: false, notice: null };
  const assistantMessageVisible = Boolean(head.messageId && (
    snapshot.display.currentMessage?.id === head.messageId && snapshot.display.currentMessage.role === 'assistant'
    || snapshot.messages.some(message => message.id === head.messageId && message.role === 'assistant')
  ));
  const notice = !assistantMessageVisible && !snapshot.display.isRunning
    ? { reason: head.reason, text: terminalText[head.reason] } : null;
  return { assistantMessageVisible, notice };
}
