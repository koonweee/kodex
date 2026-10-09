import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { defaultDisplayState } from '../../../../spikes/mastra-code-sdk/node_modules/@mastra/core/dist/agent-controller/index.js';
import { ActivityDisclosureProvider } from '../timeline/ActivityDisclosure';
import { ThreadDeliveryProvider } from '../timeline/ThreadDeliveryPreferences';
import { TimelineActivityGroupRenderer, TimelineItemRenderer } from '../timeline/renderers';
import type { ChatSnapshot } from './client';
import { timelinePresentation } from './presentation';
type Message = ChatSnapshot['messages'][number];
type Part = Message['content']['parts'][number];
function message(id: string, parts: Part[], role: Message['role'] = 'assistant'): Message {
  return { id, role, createdAt: new Date(0), content: { format: 2, parts } };
}
function tool(id: string, name = 'custom_tool', args: unknown = {}, result: unknown = 'Native output'): Part {
  return { type: 'tool-invocation', toolInvocation: { toolCallId: id, toolName: name, state: 'result', args, result } };
}
function rows(messages: Message[], display?: ChatSnapshot['display'], prompts?: ChatSnapshot['prompts']) {
  return timelinePresentation({ messages, display, prompts, revision: 1, history: { earliest: null, hasOlder: false } }).rows;
}
function identities(value: ReturnType<typeof rows>) {
  return value.map(row => row.type === 'activity' ? row.items.map(item => item.id) : row.type === 'item' ? row.item.id : row.type);
}
function RenderRows({ value }: { value: ReturnType<typeof rows> }) {
  return <MantineProvider><ActivityDisclosureProvider>{value.map(row => row.type === 'activity'
    ? <TimelineActivityGroupRenderer key={row.key} items={row.items} disclosureKeys={row.disclosureKeys} />
    : row.type === 'item' ? <TimelineItemRenderer key={row.key} item={row.item} /> : null)}</ActivityDisclosureProvider></MantineProvider>;
}
afterEach(cleanup);
it('hides only empty reasoning and includes streamed reasoning in native activity', async () => {
  const saved = message('reasoning', [tool('before'), { type: 'reasoning', reasoning: '', details: [] },
    { type: 'reasoning', reasoning: ' \n\t ', details: [] }, tool('after')]);
  const initial = rows([saved]);
  expect(identities(initial)).toEqual([['before', 'after']]);
  const view = render(<RenderRows value={initial} />);
  expect(screen.queryByText('Summary')).not.toBeInTheDocument();
  const display = defaultDisplayState();
  const completed = message('reasoning', [tool('before'), { type: 'reasoning', reasoning: 'Thinking through the result', details: [] },
    { type: 'reasoning', reasoning: ' ', details: [] }, tool('after')]);
  display.currentMessage = completed;
  display.isRunning = true;
  const streamed = rows([saved], display);
  expect(identities(streamed)).toEqual([['before', 'reasoning:1', 'after']]);
  view.rerender(<RenderRows value={streamed} />);
  expect(screen.queryByText('Thinking through the result')).not.toBeInTheDocument();
  fireEvent.click(view.container.querySelector('details > summary')!);
  fireEvent.click(screen.getByText('Reasoning'));
  expect((await screen.findByText('Summary')).closest('details')?.open).toBe(false);
  fireEvent.click(screen.getByText('Summary'));
  expect(screen.getByText('Thinking through the result')).toBeVisible();
  expect(identities(rows([completed]))).toEqual(identities(streamed));
});
it('does not let hidden reasoning erase unknown parts or message boundaries', () => {
  const empty: Part = { type: 'reasoning', reasoning: ' ', details: [] };
  expect(identities(rows([message('one', [tool('first'), empty,
    { type: 'file', data: 'BYTES', mimeType: 'application/pdf' }, empty, tool('second'), empty]),
    message('two', [empty, tool('third')])]))).toEqual([['first'], ['second'], ['third']]);
});
it.each([['view', 'Read'], ['write_file', 'Write'], ['string_replace_lsp', 'Replace'], ['ast_smart_edit', 'Edit'], ['delete_file', 'Delete']])(
  'collapses projected %s output without claiming successful file changes', async (name, action) => {
    const saved = message('files', [tool('file', name, { path: 'notes.md' }, 'Native diagnostic: operation refused')]);
    const value = rows([saved]);
    expect(value[0]).toMatchObject({ type: 'activity', items: [{ kind: 'file_change', fileChangeOutcomeKnown: false }] });
    const view = render(<RenderRows value={value} />);
    expect(screen.getByText('Requested 1 file operation')).toBeVisible();
    expect(view.container.querySelector('details')?.open).toBe(false);
    expect(screen.queryByText('Native diagnostic: operation refused')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Requested 1 file operation'));
    expect(screen.queryByText('Native diagnostic: operation refused')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText(`${action} notes.md`));
    expect(await screen.findByText('Native diagnostic: operation refused')).toBeVisible();
    expect(screen.queryByText(/Changed|Modified|Success/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/File diff/)).not.toBeInTheDocument();
    const display = defaultDisplayState(); display.currentMessage = saved;
    display.activeTools.set('file', { name, args: { path: 'notes.md' }, status: 'completed', result: 'Native diagnostic: operation refused' });
    const live = rows([saved], display);
    expect(live).toMatchObject([{ type: 'activity', key: value[0].key, items: [{ id: 'file', kind: 'file_change', action, path: 'notes.md', fileChangeOutcomeKnown: false, output: 'Native diagnostic: operation refused', status: 'completed' }] }]);
    view.rerender(<RenderRows value={live} />);
    expect(screen.getByText('Native diagnostic: operation refused')).toBeVisible();
    view.rerender(<RenderRows value={value} />);
    expect(screen.getByText('Native diagnostic: operation refused')).toBeVisible();
  },
);
it('collapses active-only file operations separately and keeps them collapsed when persisted', () => {
  const display = defaultDisplayState();
  display.activeTools.set('live-file', { name: 'view', args: { path: 'notes.md' }, status: 'completed', result: 'Active-only diagnostic' });
  display.activeTools.set('other-file', { name: 'view', args: { path: 'other.md' }, status: 'completed', result: 'Other diagnostic' });
  const live = rows([message('earlier', [tool('earlier-tool')])], display);
  expect(identities(live)).toEqual([['earlier-tool'], ['live-file'], ['other-file']]);
  const view = render(<RenderRows value={live} />);
  expect(screen.getAllByText('Requested 1 file operation')).toHaveLength(2);
  expect(screen.queryByText('Active-only diagnostic')).not.toBeInTheDocument();
  expect(screen.queryByText('Other diagnostic')).not.toBeInTheDocument();
  const saved = rows([message('saved', [tool('live-file', 'view', { path: 'notes.md' }, 'Active-only diagnostic')])]);
  view.rerender(<RenderRows value={saved} />);
  expect(screen.getByText('Requested 1 file operation')).toBeVisible();
  expect(screen.queryByText('Active-only diagnostic')).not.toBeInTheDocument();
  expect(identities(rows([], display, [{ kind: 'approval', toolName: 'view', args: { path: 'notes.md' },
    target: { sessionId: 'session', threadId: 'chat', resourceId: 'resource', runId: 'run', toolCallId: 'live-file' } }]))).toEqual(['live-file', ['other-file']]);
});
it('summarizes multiple requested file operations without claiming changes', () => {
  render(<RenderRows value={rows([message('files', [tool('read', 'view', { path: 'one.md' }),
    { type: 'reasoning', reasoning: '', details: [] }, tool('write', 'write_file', { path: 'two.md' })])])} />);
  expect(screen.getByText('Requested 2 file operations')).toBeVisible();
  expect(screen.queryByText('Native output')).not.toBeInTheDocument();
  expect(screen.queryByText(/Changed|Modified|Success/)).not.toBeInTheDocument();
});
it('keeps file approvals actionable between neighboring activity groups', () => {
  const saved = message('files', [tool('before'), tool('file', 'write_file', { path: 'notes.md' }), tool('after')]);
  expect(identities(rows([saved]))).toEqual([['before', 'file', 'after']]);
  expect(identities(rows([saved], undefined, [{ kind: 'approval', toolName: 'write_file', args: { path: 'notes.md' },
    target: { sessionId: 'session', threadId: 'chat', resourceId: 'resource', runId: 'run', toolCallId: 'file' } }]))).toEqual([['before'], 'file', ['after']]);
});
it('groups contiguous tools within each assistant message, including a single tool, without inventing turns', () => {
  const value = rows([message('one', [tool('first'), tool('shell', 'execute_command', { command: 'pwd' })]), message('two', [tool('second')]), message('user', [tool('user-tool')], 'user')]);
  expect(identities(value)).toEqual([['first', 'shell'], ['second'], 'user-tool']);
  expect(value.every(row => row.turnId === null)).toBe(true);
  expect(value[0]).toMatchObject({ type: 'activity', displayOrder: 0, items: [{ id: 'first', kind: 'dynamic_tool_call', displayOrder: 0 }, { id: 'shell', kind: 'command_execution', displayOrder: 1 }] });
});
it('groups progress, reasoning and file operations while retaining images and questions at their native positions', () => {
  const value = rows([message('mixed', [tool('before'), { type: 'text', text: 'Explanation' }, tool('after-text'),
    { type: 'reasoning', reasoning: 'Reasoning', details: [] }, tool('after-reasoning'), tool('file', 'view', { path: 'notes.md' }), tool('after-file'),
    tool('image', 'view', { path: 'pixel.png' }, { __workspaceMedia: true, text: 'Image', mediaType: 'image/png', data: 'iVBORw0KGgo=' }), tool('after-image'),
    tool('question', 'ask_user', { question: 'Choose' }), tool('after-question'), tool('plan', 'submit_plan', { path: 'plan.md' }), tool('after-plan'),
    tool('async', 'request_user_input_async', { questions: [{ title: 'Review?', options: null }] }, { accepted: true }), tool('after-async')])]);
  expect(identities(value)).toEqual([['before', 'mixed:1', 'after-text', 'mixed:3', 'after-reasoning', 'file', 'after-file'], 'image', ['after-image'], 'question', ['after-question'], 'plan', ['after-plan'], '["mixed","async"]', ['after-async']]);
  expect(value.find(row => row.type === 'item' && row.item.id === '["mixed","async"]')).toMatchObject({ item: { asyncQuestions: [{ title: 'Review?' }] } });
});
it('applies overlays before grouping, exposes pending prompts, and converges live and saved identities', () => {
  const saved = message('live', [tool('shell', 'execute_command', { command: 'false' }, 'Exit code: 1'), tool('custom')]);
  const display = defaultDisplayState(); display.currentMessage = saved;
  display.activeTools.set('shell', { name: 'execute_command', args: { command: 'false' }, status: 'running', shellOutput: 'Partial' });
  const initial = rows([saved], display);
  expect(initial[0]).toMatchObject({ type: 'activity', items: [{ id: 'shell', status: 'running', output: 'Partial' }, { id: 'custom' }] });
  const key = initial[0].key;
  display.activeTools.set('shell', { name: 'execute_command', args: { command: 'false' }, status: 'completed', result: 'Exit code: 1' });
  const completed = rows([saved], display)[0], persisted = rows([saved])[0];
  expect(completed).toMatchObject({ type: 'activity', key, items: [{ id: 'shell', status: 'completed', output: 'Exit code: 1' }, { id: 'custom', output: 'Native output' }] });
  expect(persisted).toMatchObject({ type: 'activity', key, items: [{ id: 'shell', status: 'completed', output: 'Exit code: 1' }, { id: 'custom', output: 'Native output' }] });
  const target = { sessionId: 'session', threadId: 'chat', resourceId: 'resource', runId: 'run', toolCallId: 'custom' };
  const pending = rows([saved], display, [{ kind: 'approval', target, toolName: 'custom_tool', args: {} }]);
  expect(identities(pending)).toEqual([['shell'], 'custom']); expect(pending[1]).toMatchObject({ item: { status: 'approval_required' } });
  display.activeTools.set('orphan', { name: 'custom_tool', args: {}, status: 'running' });
  expect(identities(rows([saved], display))).toEqual([['shell', 'custom'], ['orphan']]);
});
it('uses the shared collapsed disclosure and reveals native command output on explicit opening', async () => {
  const value = rows([message('shell', [tool('command', 'execute_command', { command: 'exit 7' }, 'Exit code: 7')])]);
  expect(value[0].type).toBe('activity'); if (value[0].type !== 'activity') throw new Error('Expected native activity');
  const view = render(<MantineProvider><ThreadDeliveryProvider includeCommandOutputs><TimelineActivityGroupRenderer items={value[0].items} /></ThreadDeliveryProvider></MantineProvider>);
  const details = view.container.querySelector('details')!;
  expect(details.open).toBe(false); expect(screen.getByText('Ran 1 command')).toBeVisible(); expect(screen.queryByText('Exit code: 7')).not.toBeInTheDocument();
  fireEvent.click(screen.getByText('Ran 1 command'));
  expect(details.open).toBe(true); expect(screen.queryByText('Exit code: 7')).not.toBeInTheDocument();
  fireEvent.click(screen.getByText('Ran exit 7')); expect(await screen.findByText('Exit code: 7')).toBeVisible(); expect(screen.queryByText('Success')).not.toBeInTheDocument();
});

it('does not group across an unrendered native part or attribute an overlay to another message', () => {
  const older = message('older', [tool('duplicate'), tool('old-sibling')]);
  const newer = message('newer', [tool('duplicate'), { type: 'file', data: 'BYTES', mimeType: 'application/pdf' }, tool('new-sibling')]);
  const display = defaultDisplayState();
  display.activeTools.set('duplicate', { name: 'custom_tool', args: {}, status: 'running', partialResult: 'Current only' });
  const value = rows([older, newer], display);
  expect(identities(value)).toEqual([['duplicate', 'old-sibling'], ['duplicate'], ['new-sibling']]);
  expect(value[0]).toMatchObject({ items: [{ id: 'duplicate', status: 'completed', output: 'Native output' }, { id: 'old-sibling' }] });
  expect(value[1]).toMatchObject({ items: [{ id: 'duplicate', status: 'running', output: 'Current only' }] });
  expect(new Set(value.map(row => row.key)).size).toBe(value.length);
});


it.each(['execute_command', 'custom_tool', 'write_file'])('collapses %s before arguments or message provenance arrive', (name) => {
  const display = defaultDisplayState();
  display.activeTools.set('early', { name, args: {}, status: 'running' });
  const value = rows([], display);
  expect(value[0]).toMatchObject({ type: 'activity', items: [{ id: 'early', status: 'running' }] });
  const view = render(<RenderRows value={value} />);
  expect(view.container.querySelector('details')?.open).toBe(false);
  expect(screen.queryByText('Arguments: {}')).not.toBeInTheDocument();
});
it.each([
  { name: 'execute_command', args: { command: 'pwd' }, kind: 'command_execution' },
  { name: 'write_file', args: { path: 'notes.md', content: 'hello' }, kind: 'file_change' },
])('retains saved $name arguments under an empty live placeholder', ({ name, args, kind }) => {
  const display = defaultDisplayState();
  display.activeTools.set('same', { name, args: {}, status: 'running' });
  const value = rows([message('saved', [tool('same', name, args)])], display);
  expect(value[0]).toMatchObject({ type: 'activity', items: [{ kind, argsSummary: JSON.stringify(args, null, 2) }] });
});

it('preserves explicit group and tool inspection when live tools merge into a saved message', async () => {
  const display = defaultDisplayState();
  display.activeTools.set('live', { name: 'custom_tool', args: {}, status: 'running', partialResult: 'Partial output' });
  const view = render(<RenderRows value={rows([], display)} />);
  const group = () => view.container.querySelector<HTMLDetailsElement>('.kodex-activity-group')!;
  expect(group().open).toBe(false);
  expect(screen.getByText('Running')).toBeVisible();
  fireEvent.click(group().querySelector('summary')!);
  fireEvent.click(screen.getByText('Used custom_tool'));
  expect(await screen.findByText('Result: Partial output')).toBeVisible();
  const saved = message('saved', [tool('earlier'), tool('live', 'custom_tool', {}, 'Final output')]);
  view.rerender(<RenderRows value={rows([saved])} />);
  expect(group().open).toBe(true);
  expect(screen.queryByText('Running')).not.toBeInTheDocument();
  expect(await screen.findByText('Result: Final output')).toBeVisible();
  fireEvent.click(group().querySelector('summary')!);
  view.rerender(<RenderRows value={rows([message('saved', [tool('earlier'), tool('live'), tool('later')])])} />);
  expect(group().open).toBe(false);
});

it('keeps explicit replacement arguments and different tool names authoritative', () => {
  const saved = message('saved', [tool('same', 'write_file', { path: 'old.md' })]);
  const display = defaultDisplayState();
  display.activeTools.set('same', { name: 'write_file', args: { path: 'new.md' }, status: 'running' });
  expect(rows([saved], display)[0]).toMatchObject({ items: [{ path: 'new.md' }] });
  display.activeTools.set('same', { name: 'custom_tool', args: {}, status: 'running' });
  expect(rows([saved], display)[0]).toMatchObject({ items: [{ kind: 'dynamic_tool_call', argsSummary: '{}', path: undefined }] });
});
it('keeps historical duplicate tool IDs separate from the live disclosure choice', async () => {
  const older = message('older', [tool('same')]);
  const newer = message('newer', [tool('same')]);
  const value = rows([older, newer]);
  const view = render(<RenderRows value={value} />);
  const groups = view.container.querySelectorAll<HTMLDetailsElement>('.kodex-activity-group');
  fireEvent.click(groups[1].querySelector('summary')!);
  expect(groups[1].open).toBe(true);
  expect(groups[0].open).toBe(false);
});

it('does not transfer an opened saved call to a later call reusing its native ID', async () => {
  const first = message('first', [tool('repeated')]);
  const view = render(<RenderRows value={rows([first])} />);
  fireEvent.click(view.container.querySelector('summary')!);
  await screen.findByText('Used custom_tool');
  view.rerender(<RenderRows value={rows([first, message('second', [tool('repeated')])])} />);
  const groups = view.container.querySelectorAll<HTMLDetailsElement>('.kodex-activity-group');
  expect(groups[0].open).toBe(true);
  expect(groups[1].open).toBe(false);
});
