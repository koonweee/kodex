import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { defaultDisplayState } from '../../../../spikes/mastra-code-sdk/node_modules/@mastra/core/dist/agent-controller/index.js';
import { TimelineActivityGroupRenderer, TimelineItemRenderer } from '../timeline/renderers';
import type { ChatSnapshot } from './client';
import { timelinePresentation } from './presentation';

type Message = ChatSnapshot['messages'][number];
type Part = Message['content']['parts'][number];
const text = (value: string): Part => ({ type: 'text', text: value });
const reasoning = (value: string): Part => ({ type: 'reasoning', reasoning: value, details: [] });
function tool(id: string, name = 'custom_tool', args: unknown = {}, result: unknown = 'Tool diagnostics'): Part {
  return { type: 'tool-invocation', toolInvocation: { toolCallId: id, toolName: name, state: 'result', args, result } };
}
function message(id: string, parts: Part[], role: Message['role'] = 'assistant'): Message {
  return { id, role, createdAt: new Date(0), content: { format: 2, parts } };
}
function rows(messages: Message[], display?: ChatSnapshot['display'], prompts?: ChatSnapshot['prompts']) {
  return timelinePresentation({ messages, display, prompts, revision: 1, history: { earliest: null, hasOlder: false } }).rows;
}
function identities(value: ReturnType<typeof rows>) {
  return value.map(row => row.type === 'activity' ? row.items.map(item => item.id) : row.type === 'item' ? row.item.id : row.type);
}
function RenderRows({ value }: { value: ReturnType<typeof rows> }) {
  return <MantineProvider>{value.map(row => row.type === 'activity'
    ? <TimelineActivityGroupRenderer key={row.key} items={row.items} fallbackSummary={row.fallbackSummary} />
    : row.type === 'item' ? <TimelineItemRenderer key={row.key} item={row.item} /> : null)}</MantineProvider>;
}
afterEach(cleanup);

it('uses a neutral native fallback while retaining command/file counts and the mainline fallback', () => {
  const reasoningRows = rows([message('reasoning', [reasoning('Consider the implementation')])]);
  const view = render(<RenderRows value={reasoningRows} />);
  expect(screen.getByText('Activity')).toBeVisible();
  expect(screen.queryByText('Worked')).not.toBeInTheDocument();

  view.rerender(<RenderRows value={rows([message('command', [reasoning('Check the result'),
    tool('run', 'execute_command', { command: 'pwd' })])])} />);
  expect(screen.getByTitle('Ran 1 command')).toBeVisible();

  view.rerender(<RenderRows value={rows([message('file', [reasoning('Read the file'),
    tool('read', 'view', { path: 'notes.md' })])])} />);
  expect(screen.getByText('Requested 1 file operation')).toBeVisible();

  const group = reasoningRows[0];
  if (group.type !== 'activity') throw new Error('Expected activity');
  view.rerender(<MantineProvider><TimelineActivityGroupRenderer items={group.items} /></MantineProvider>);
  expect(screen.getByText('Worked')).toBeVisible();
  expect(screen.queryByText('Activity')).not.toBeInTheDocument();
});

it('folds native reasoning, progress text and tools while leaving the trailing answer visible', async () => {
  const value = rows([message('mixed', [reasoning('Consider the relevant files'), text('Checking the implementation'),
    tool('read', 'view', { path: 'notes.md' }), reasoning('Compare the result'), tool('check'), text('The answer is ready')])]);
  expect(identities(value)).toEqual([['mixed:0', 'mixed:1', 'read', 'mixed:3', 'check'], 'mixed:5']);
  expect(value.every(row => row.turnId === null)).toBe(true);
  const view = render(<RenderRows value={value} />);
  expect(await screen.findByText('The answer is ready')).toBeVisible();
  expect(screen.queryByText('Checking the implementation')).not.toBeInTheDocument();
  expect(screen.queryByText('Consider the relevant files')).not.toBeInTheDocument();
  const group = view.container.querySelector<HTMLDetailsElement>('details')!;
  expect(group.open).toBe(false);
  fireEvent.click(group.querySelector('summary')!);
  const progress = Array.from(group.querySelectorAll<HTMLDetailsElement>('details')).find(detail =>
    detail.querySelector('summary')?.textContent === 'Assistant');
  expect(progress).toBeDefined();
  fireEvent.click(progress!.querySelector('summary')!);
  expect(await screen.findByText('Checking the implementation')).toBeVisible();
  expect(screen.getByText('The answer is ready')).toBeVisible();
  fireEvent.click(within(group).getByText('Read notes.md'));
  expect(await screen.findByText('Tool diagnostics')).toBeVisible();
});

it('keeps streamed trailing text visible until a native tool follows and converges with saved history', async () => {
  const initial = message('stream', [reasoning('Investigating'), tool('first'), text('The current explanation')]);
  const display = defaultDisplayState();
  display.isRunning = true;
  display.currentMessage = initial;
  const initialRows = rows([], display);
  expect(identities(initialRows)).toEqual([['stream:0', 'first'], 'stream:2']);
  const view = render(<RenderRows value={initialRows} />);
  expect(await screen.findByText('The current explanation')).toBeVisible();

  const continued = message('stream', [...initial.content.parts, tool('next'), text('The retained answer')]);
  display.currentMessage = continued;
  const liveRows = rows([], display);
  expect(identities(liveRows)).toEqual([['stream:0', 'first', 'stream:2', 'next'], 'stream:4']);
  expect(liveRows[0].key).toBe(initialRows[0].key);
  view.rerender(<RenderRows value={liveRows} />);
  expect(screen.queryByText('The current explanation')).not.toBeInTheDocument();
  expect(await screen.findByText('The retained answer')).toBeVisible();

  const savedRows = rows([continued]);
  expect(identities(savedRows)).toEqual(identities(liveRows));
  view.rerender(<RenderRows value={savedRows} />);
  expect(screen.queryByText('The current explanation')).not.toBeInTheDocument();
  expect(screen.getByText('The retained answer')).toBeVisible();
});

it('preserves text-only messages, trailing text parts and user replies without borrowing later tool boundaries', () => {
  const value = rows([message('explanation', [text('First text'), text('Second text')]),
    message('work', [tool('tool'), text('Answer'), text('More answer'), reasoning('Trailing reasoning')]),
    message('reply', [text('User reply')], 'user'), message('next', [tool('next-tool')])]);
  expect(identities(value)).toEqual(['explanation:0', 'explanation:1', ['tool'], 'work:1', 'work:2', ['work:3'], 'reply:0', ['next-tool']]);
});

it.each<Part>([
  { type: 'step-start' },
  { type: 'file', data: 'BYTES', mimeType: 'application/pdf' },
])('does not fold text or merge activity across an unrendered $type part', boundary => {
  const value = rows([message('boundary', [tool('before'), reasoning('First step'), text('Keep this text'), boundary,
    reasoning('Next step'), tool('after'), text('Answer')])]);
  expect(identities(value)).toEqual([['before', 'boundary:1'], 'boundary:2', ['boundary:4', 'after'], 'boundary:6']);
});

it.each([
  ['question', 'ask_user', { question: 'Choose?' }, 'Answer', 'gate'],
  ['plan', 'submit_plan', { path: 'plan.md' }, 'Submitted', 'gate'],
  ['async question', 'request_user_input_async', { questions: [{ title: 'Review?', options: null }] }, { accepted: true }, '["barrier","gate"]'],
  ['image', 'view', { path: 'pixel.png' }, { __workspaceMedia: true, text: 'Image', mediaType: 'image/png', data: 'iVBORw0KGgo=' }, 'gate'],
])('keeps %s prominent and prevents folding across it', (_label, name, args, result, id) => {
  const value = rows([message('barrier', [tool('before'), text('Visible before interaction'), tool('gate', String(name), args, result),
    reasoning('After interaction'), tool('after'), text('Answer')])]);
  expect(identities(value)).toEqual([['before'], 'barrier:1', id, ['barrier:3', 'after'], 'barrier:5']);
});

it('does not hide explicit native errors as progress or fold across pending approvals', () => {
  const target = { sessionId: 'session', threadId: 'chat', resourceId: 'resource', runId: 'run', toolCallId: 'approval' };
  const approval = rows([message('approval', [reasoning('Before approval'), text('Review this request'),
    tool('approval', 'write_file', { path: 'notes.md' }), text('Next step'), tool('after')])], undefined,
  [{ kind: 'approval', target, toolName: 'write_file', args: { path: 'notes.md' } }]);
  expect(identities(approval)).toEqual([['approval:0'], 'approval:1', 'approval', ['approval:3', 'after']]);

  const error = rows([message('failed', [tool('before'), { type: 'error', error: { name: 'Error', message: 'Native failure' } }, tool('after')])]);
  expect(identities(error)).toEqual([['before'], 'failed:1', ['after']]);
  expect(error[1]).toMatchObject({ type: 'item', item: { text: 'Native failure', status: 'failed' } });
});
