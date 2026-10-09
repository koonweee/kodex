import type { TimelinePresentation } from '../timeline/TimelineView';
import type { TimelineRow, TimelineWorkRow } from '../timeline/state';
import type { ChatSnapshot } from './client';

/** Presentation-only activity spans, not native turns or successful-run records. */
export function nativeWorkPresentation(presentation: TimelinePresentation | null, snapshot: ChatSnapshot | null, chatId: string | null, archived: boolean): TimelinePresentation | null {
  if (!presentation || !snapshot || snapshot.chat.id !== chatId || archived) return presentation;
  const waiting = snapshot.prompts.some(prompt => prompt.kind !== 'unsupported' && prompt.target.threadId === chatId);
  const active = waiting || snapshot.display.isRunning;
  const source = presentation.rows;
  let lastUser = -1;
  source.forEach((row, index) => { if (row.type === 'item' && row.item.kind === 'user_message') lastUser = index; });
  const rows: TimelineRow[] = [];
  let pending: Extract<TimelineRow, { type: 'activity' }>[] = [];
  const workRow = (key: string, displayOrder: number, collapsedRows: TimelineWorkRow['collapsedRows'], running = false): TimelineWorkRow => ({
    type: 'work', key, turnKey: key, turnId: null, displayOrder, collapsedRows,
    state: running ? 'running' : 'completed', ...(running && { statusLabel: waiting ? 'Waiting for your response' : 'Working' }),
  });
  function flush(answer?: Extract<TimelineRow, { type: 'item' }>) {
    if (!pending.length) return;
    if (answer && pending.at(-1)!.nativeWorkBoundary !== undefined && pending.at(-1)!.nativeWorkBoundary === answer.nativeWorkBoundary) rows.push(workRow(JSON.stringify(['native-work', answer.key]), pending[0].displayOrder, pending));
    else rows.push(...pending);
    pending = [];
  }
  for (let index = 0; index <= source.length; index += 1) {
    if (active && index === lastUser + 1) {
      flush();
      const anchor = source[lastUser]?.key ?? 'start';
      rows.push(workRow(JSON.stringify(['native-working', chatId, anchor]), source[index]?.displayOrder ?? index, [], true));
    }
    const row = source[index];
    if (!row) { flush(); break; }
    if (active && index > lastUser) { rows.push(row); continue; }
    const eligible = row.type === 'activity' && row.items.every(item => item.status === 'completed');
    if (eligible) {
      if (pending.length && (row.nativeWorkBoundary === undefined || pending.at(-1)!.nativeWorkBoundary !== row.nativeWorkBoundary)) flush();
      pending.push(row);
    } else {
      flush(row.type === 'item' && row.item.kind === 'assistant_message' && row.item.text.trim() && row.item.status === 'completed' ? row : undefined);
      rows.push(row);
    }
  }
  return { ...presentation, rows };
}
