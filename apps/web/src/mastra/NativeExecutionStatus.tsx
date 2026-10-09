import { Text } from '@mantine/core';
import type { ChatSnapshot } from './client';

export function NativeExecutionStatus({ snapshot, chatId, archived }: { snapshot: ChatSnapshot | null; chatId: string; archived: boolean }) {
  if (!snapshot || snapshot.chat.id !== chatId || archived) return null;
  const waiting = snapshot.prompts.some(prompt => prompt.kind !== 'unsupported' && prompt.target.threadId === chatId);
  if (!waiting && !snapshot.display.isRunning) return null;
  return <Text className="kodex-thread-column" role="status" size="sm" c="dimmed" py="xs">
    {waiting ? 'Waiting for your response' : 'Working'}
  </Text>;
}
