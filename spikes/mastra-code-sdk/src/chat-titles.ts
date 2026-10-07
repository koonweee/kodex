import type { ProjectRuntime, NativeSession } from './runtime.js';

type NativeThread = NonNullable<Awaited<ReturnType<ProjectRuntime['controller']['queryThreadById']>>>;
/** Frozen main treats this native name as unnamed, falling back to the first input. */
export const UNNAMED_CHAT_TITLE = 'New thread';
const PLACEHOLDER_MARKER = 'kodexUnnamedTitle';

export function readChatName(thread: NativeThread): string | null {
  const name = thread.title?.trim();
  // Native title origin only: no duplicate name/preview. This distinguishes an
  // explicit manual 'New thread' name from Kodex's creation placeholder.
  return name && !(name === UNNAMED_CHAT_TITLE && thread.metadata?.[PLACEHOLDER_MARKER] === true) ? name : null;
}
export const CHAT_PREVIEW_LIMIT = 512;
export const CHAT_PREVIEW_PAGE_SIZE = 32;

export async function pinUnnamedChat(session: NativeSession): Promise<void> {
  // Awaited before creation is exposed to any client or its first submission.
  // A nonempty native title suppresses first-turn model naming; the native pin
  // also keeps OM title extraction from replacing the placeholder/manual name.
  await session.thread.rename({ title: UNNAMED_CHAT_TITLE, pin: true });
  await session.thread.setSetting({ key: PLACEHOLDER_MARKER, value: true });
}

export async function renameNativeChat(session: NativeSession, title: string): Promise<void> {
  await session.thread.rename({ title });
  await session.thread.setSetting({ key: PLACEHOLDER_MARKER, value: false });
}

export async function readChatTitle(runtime: ProjectRuntime, thread: NativeThread): Promise<string> {
  const name = readChatName(thread);
  if (name) return name.replace(/\s+/g, ' ');
  // Public read-only API: no session activation and no unbounded first-user scan.
  // If the bounded oldest page contains no retained user input, keep the fallback.
  const page = await runtime.controller.queryThreadMessages({ threadId: thread.id, resourceId: thread.resourceId,
    perPage: CHAT_PREVIEW_PAGE_SIZE, page: 0, orderBy: { field: 'createdAt', direction: 'ASC' } });
  const first = page.messages.find(message => {
    const signal = message.content.metadata?.signal;
    return message.role === 'user' || (message.role === 'signal' && typeof signal === 'object' && signal !== null && 'type' in signal && (signal.type === 'user' || signal.type === 'user-message'));
  });
  const text = first?.content.parts.filter(part => part.type === 'text').map(part => part.text).join(' ').replace(/\s+/g, ' ').trim();
  return text ? Array.from(text).slice(0, CHAT_PREVIEW_LIMIT).join('') : UNNAMED_CHAT_TITLE;
}
