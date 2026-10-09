import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { VirtuosoMockContext } from 'react-virtuoso';
import { TimelineView } from '../timeline/TimelineView';
import { defaultDisplayState } from '../../../../spikes/mastra-code-sdk/node_modules/@mastra/core/dist/agent-controller/index.js';
import { TimelineActivityGroupRenderer, TimelineItemRenderer, TimelineWorkRowRenderer } from '../timeline/renderers';
import type { TimelineRow } from '../timeline/state';
import type { ChatSnapshot } from './client';
import { nativeQueueFixture, nativeReadStateFixture, nativeSettingsFixture } from './testBuilders';
import { timelinePresentation } from './presentation';
import { nativeWorkPresentation } from './nativeWorkPresentation';

type Message = ChatSnapshot['messages'][number];
type Part = Message['content']['parts'][number];
const text = (text: string): Part => ({ type: 'text', text });
const tool = (id: string): Part => ({ type: 'tool-invocation', toolInvocation: { toolCallId: id, toolName: 'custom_tool', state: 'result', args: {}, result: 'Diagnostics' } });
function message(id: string, parts: Part[], role: Message['role'] = 'assistant'): Message {
  return { id, role, createdAt: new Date(0), content: { format: 2, parts } };
}
function snapshot(messages: Message[], running = false): ChatSnapshot {
  return { epoch: 'epoch', revision: 1, readState: nativeReadStateFixture(),
    chat: { bindingId: 'binding', id: 'chat', projectId: null, cwd: '/project', title: 'Chat', name: null, pinned: false, notificationsEnabled: true },
    display: { ...defaultDisplayState(), isRunning: running }, messages, error: null, prompts: [], goal: null,
    queue: nativeQueueFixture(), settings: nativeSettingsFixture(), history: { earliest: null, hasOlder: false } };
}
function project(value: ChatSnapshot) { return nativeWorkPresentation(timelinePresentation(value), value, 'chat', false)!; }
const conversation = () => [message('user', [text('Do the work')], 'user'), message('one', [tool('a')]), message('two', [tool('b')]), message('answer', [text('Here is the answer')])];
function Row({ row }: { row: TimelineRow }) {
  const [expanded, setExpanded] = useState(false);
  if (row.type === 'work') return <TimelineWorkRowRenderer row={row} expanded={expanded} onExpandedChange={setExpanded}>{row.collapsedRows.map(child => <Row key={child.key} row={child} />)}</TimelineWorkRowRenderer>;
  if (row.type === 'activity') return <TimelineActivityGroupRenderer items={row.items} fallbackSummary={row.fallbackSummary} disclosureKeys={row.disclosureKeys} />;
  return row.type === 'item' ? <TimelineItemRenderer item={row.item} /> : null;
}
function Transcript({ value }: { value: ChatSnapshot }) { return <MantineProvider>{project(value).rows.map(row => <Row key={row.key} row={row} />)}</MantineProvider>; }
afterEach(cleanup);

it('wraps activity across native messages once, leaving the answer visible and details lazy', async () => {
  const value = snapshot(conversation());
  const rows = project(value).rows;
  expect(rows.map(row => row.type)).toEqual(['item', 'work', 'item']);
  const work = rows[1];
  expect(work).toMatchObject({ type: 'work', turnId: null, state: 'completed' });
  if (work.type !== 'work') throw new Error('Expected work');
  expect(work.collapsedRows).toHaveLength(2);
  expect(work.startedAtMs).toBeUndefined();
  const view = render(<Transcript value={value} />);
  expect(await screen.findByText('Here is the answer')).toBeVisible();
  expect(screen.queryByText('Used 1 tool')).not.toBeInTheDocument();
  const details = view.container.querySelector('details')!;
  expect(details.open).toBe(false);
  fireEvent.click(screen.getByText('Worked'));
  expect(await screen.findAllByText('Used 1 tool')).toHaveLength(2);
});

it('captures all four calls across saved native step and bookkeeping records', async () => {
  const bookkeeping: Part[] = [{ type: 'data-workspace-metadata', data: {} }, { type: 'data-sandbox-exit', data: { exitCode: 0 } }, { type: 'step-start' }];
  const messages = [
    message('user', [text('Try four calls')], 'user'),
    message('first', [text('First progress'), tool('one'), ...bookkeeping,
      text('Second progress'), tool('two'), bookkeeping[0], bookkeeping[2],
      tool('three'), ...bookkeeping]),
    message('second', [text('Third progress'), tool('four'), ...bookkeeping, text('Done with four calls')]),
  ];
  const value = snapshot(messages);
  const rows = project(value).rows;
  expect(rows.map(row => row.type)).toEqual(['item', 'work', 'item']);
  const work = rows[1];
  if (work.type !== 'work') throw new Error('Expected work');
  expect(work.collapsedRows.flatMap(row => row.type === 'activity' ? row.items.filter(item => item.toolName).map(item => item.id) : [])).toEqual(['one', 'two', 'three', 'four']);
  const view = render(<Transcript value={value} />);
  expect(await screen.findByText('Done with four calls')).toBeVisible();
  expect(view.container.querySelectorAll('.kodex-activity-group')).toHaveLength(0);
  fireEvent.click(screen.getByText('Worked'));
  expect(await screen.findAllByText('Used 1 tool')).toHaveLength(4);
  expect(project(snapshot(structuredClone(messages))).rows).toEqual(rows);
});

it.each(['step-start', 'data-workspace-metadata', 'data-sandbox-command', 'data-sandbox-stdout', 'data-sandbox-stderr', 'data-sandbox-exit'])('keeps %s transparent only to outer work', type => {
  const boundary: Part = type === 'step-start' ? { type: 'step-start' } : { type: `data-${type.slice(5)}`, data: {} };
  const rows = project(snapshot([message('mixed', [tool('a'), boundary, tool('b'), text('Answer')])])).rows;
  expect(rows.map(row => row.type)).toEqual(['work', 'item']);
  expect(rows[0]).toMatchObject({ collapsedRows: [{ type: 'activity', items: [{ id: 'a' }] }, { type: 'activity', items: [{ id: 'b' }] }] });
});

it('anchors Working above live activity and collapses only on canonical settlement', async () => {
  const value = snapshot(conversation(), true);
  const live = project(value).rows;
  expect(live.map(row => row.type)).toEqual(['item', 'work', 'activity', 'activity', 'item']);
  expect(live[1]).toMatchObject({ state: 'running', collapsedRows: [] });
  const view = render(<Transcript value={value} />);
  const status = screen.getByRole('status');
  expect(status).toHaveTextContent('Working');
  expect(status.compareDocumentPosition(screen.getAllByText('Used 1 tool')[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.queryByText('Worked')).not.toBeInTheDocument();
  view.rerender(<Transcript value={{ ...value, display: defaultDisplayState(), revision: 2 }} />);
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  expect(screen.getByText('Worked')).toBeVisible();
  expect(screen.queryByText('Used 1 tool')).not.toBeInTheDocument();
  expect(await screen.findByText('Here is the answer')).toBeVisible();
});

it('does not combine across unknown parts, visible replies or interactive calls', () => {
  for (const boundary of [{ type: 'data-unknown', data: {} } satisfies Part, text('Visible reply'), { type: 'tool-invocation', toolInvocation: { toolCallId: 'ask', toolName: 'ask_user', state: 'result', args: {}, result: 'Question' } } satisfies Part]) {
    const value = snapshot([message('user', [text('Go')], 'user'), message('mixed', [tool('a'), boundary, tool('b'), text('Answer')])]);
    const rows = project(value).rows;
    const work = rows.filter(row => row.type === 'work');
    expect(work.every(row => row.collapsedRows.length === 1)).toBe(true);
    expect(rows.some(row => row.type === 'activity' && row.items.some(item => item.id === 'a')) || work.some(row => row.collapsedRows.some(child => child.type === 'activity' && child.items.some(item => item.id === 'a')))).toBe(true);
  }
});

it('keeps barriers before answers and unresolved tools outside Worked', () => {
  const unfinished: Part = { type: 'tool-invocation', toolInvocation: { toolCallId: 'pending', toolName: 'custom_tool', state: 'call', args: {} } };
  for (const messages of [
    [message('mixed', [tool('a'), { type: 'data-unknown', data: {} }, text('Answer')])],
    [message('work', [tool('a'), { type: 'data-unknown', data: {} }]), message('answer', [text('Answer')])],
    [message('work', [unfinished, text('Answer')])],
  ]) expect(project(snapshot(messages)).rows.some(row => row.type === 'work')).toBe(false);
});

it('retains expansion when older activity is prepended into the same span', async () => {
  const messages = conversation().slice(1);
  const partial = snapshot(messages.slice(1));
  const view = render(<Transcript value={partial} />);
  fireEvent.click(screen.getByText('Worked'));
  expect(await screen.findAllByText('Used 1 tool')).toHaveLength(1);
  view.rerender(<Transcript value={snapshot(messages)} />);
  expect(await screen.findAllByText('Used 1 tool')).toHaveLength(2);
  expect(view.container.querySelector('details')!.open).toBe(true);
});

it('restores the reader scroll anchor when prepend grows a folded span without adding a top-level row', async () => {
  const scroller = document.createElement('div');
  document.body.append(scroller);
  let height = 1000;
  Object.defineProperty(scroller, 'scrollHeight', { get: () => height });
  Object.defineProperty(scroller, 'clientHeight', { value: 400 });
  scroller.scrollTop = 100;
  const messages = conversation().slice(1);
  function timeline(value: ChatSnapshot, loading: boolean) {
    return <MantineProvider><VirtuosoMockContext.Provider value={{ viewportHeight: 720, itemHeight: 96 }}>
      <TimelineView approvals={[]} imagePreviewUrlsByPath={{}} onApprovalDecision={vi.fn()} onImageOpen={vi.fn()} onMarkdownOpen={vi.fn()} onReady={vi.fn()} scrollParentElement={scroller} showDebug={false} threadId="chat" timeline={{ ...project(value), isLoadingOlderHistory: loading }} />
    </VirtuosoMockContext.Provider></MantineProvider>;
  }
  const partial = snapshot(messages.slice(1));
  const view = render(timeline(partial, false));
  scroller.scrollTop = 100;
  view.rerender(timeline(partial, true));
  height = 1200;
  view.rerender(timeline(snapshot(messages), false));
  expect(scroller.scrollTop).toBe(300);
  scroller.remove();
});

it('keeps failed activity and answerless history outside Worked', () => {
  const failed: Part = { type: 'tool-invocation', toolInvocation: { toolCallId: 'failed', toolName: 'custom_tool', state: 'result', args: {}, result: 'Failed', isError: true } };
  expect(project(snapshot([message('work', [tool('a')])])).rows.map(row => row.type)).toEqual(['activity']);
  expect(project(snapshot([message('work', [failed, text('Explanation')])])).rows.map(row => row.type)).toEqual(['activity', 'item']);
});

it('preserves settled history while showing only the latest request as live', () => {
  const value = snapshot([...conversation(), message('next-user', [text('Next')], 'user'), message('next-work', [tool('next')])], true);
  const work = project(value).rows.filter(row => row.type === 'work');
  expect(work.map(row => row.state)).toEqual(['completed', 'running']);
});

it('converges across peer, live-message settlement and reload snapshots', () => {
  const messages = conversation();
  const live = snapshot(messages.slice(0, -1));
  live.display = { ...live.display, currentMessage: messages.at(-1)! };
  expect(project(live).rows).toEqual(project(snapshot(messages)).rows);
  expect(project(snapshot(messages)).rows).toEqual(project(structuredClone(snapshot(messages))).rows);
});
