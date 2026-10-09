import { MantineProvider } from '@mantine/core';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { defaultDisplayState } from '../../../../spikes/mastra-code-sdk/node_modules/@mastra/core/dist/agent-controller/index.js';
import type { ChatSnapshot } from './client';
import { nativeQueueFixture, nativeReadStateFixture, nativeSettingsFixture } from './testBuilders';
import { nativeWorkPresentation } from './nativeWorkPresentation';
import { timelinePresentation } from './presentation';
import { TimelineWorkRowRenderer } from '../timeline/renderers';

const target = { sessionId: 'session', threadId: 'chat', resourceId: 'resource', runId: 'run', toolCallId: 'tool' };
function snapshot(running = false, prompts: ChatSnapshot['prompts'] = []): ChatSnapshot {
  return { epoch: 'epoch', revision: 1, readState: nativeReadStateFixture(),
    chat: { bindingId: 'binding', id: 'chat', projectId: null, cwd: '/project', title: 'Chat', name: null, pinned: false, notificationsEnabled: true },
    display: { ...defaultDisplayState(), isRunning: running }, messages: [], error: null, prompts, goal: null,
    queue: nativeQueueFixture(), settings: nativeSettingsFixture(), history: { earliest: null, hasOlder: false } };
}
function status(value: ChatSnapshot | null, chatId = 'chat', archived = false) {
  const timeline = nativeWorkPresentation(value ? timelinePresentation(value) : null, value, chatId, archived);
  return <MantineProvider env="test">{timeline?.rows.map(row => row.type === 'work' ? <TimelineWorkRowRenderer key={row.key} row={row} /> : null)}</MantineProvider>;
}
afterEach(cleanup);

it('projects working, waiting, resumed and idle directly from successive canonical snapshots', () => {
  const view = render(status(snapshot(true)));
  expect(screen.getByRole('status')).toHaveTextContent('Working');
  view.rerender(status(snapshot(false, [{ kind: 'question', target, question: 'Continue?' }])));
  expect(screen.getByRole('status')).toHaveTextContent('Waiting for your response');
  view.rerender(status(snapshot(true)));
  expect(screen.getByRole('status')).toHaveTextContent('Working');
  view.rerender(status(snapshot()));
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});

it.each<ChatSnapshot['prompts'][number]>([
  { kind: 'question', target, question: 'Continue?' },
  { kind: 'approval', target, toolName: 'execute_command', args: {} },
  { kind: 'plan', target, path: 'plan.md' },
])('prioritizes the current chat’s bound $kind prompt over running', prompt => {
  render(status(snapshot(true, [prompt])));
  expect(screen.getByRole('status')).toHaveTextContent('Waiting for your response');
});

it('does not derive waiting from unsupported, detached, child or asynchronous requests', () => {
  const value = snapshot(true, [
    { kind: 'unsupported', target: null, toolCallId: 'detached', toolName: 'ask_user', reason: 'Detached' },
    { kind: 'unsupported', target, toolCallId: 'unknown', toolName: 'other', reason: 'Unsupported' },
    { kind: 'question', target: { ...target, threadId: 'child' }, question: 'Child question' },
  ]);
  value.messages = [{ id: 'async', role: 'assistant', createdAt: new Date(0), content: { format: 2, parts: [
    { type: 'tool-invocation', toolInvocation: { state: 'result', toolCallId: 'async-call', toolName: 'request_user_input_async', args: { questions: [{ title: 'Later?', options: null }] }, result: { accepted: true } } },
  ] } }];
  const view = render(status(value));
  expect(screen.getByRole('status')).toHaveTextContent('Working');
  view.rerender(status({ ...value, display: { ...value.display, isRunning: false } }));
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});

it('clears status from peer updates, chat switches, unavailable and archived snapshots', () => {
  const running = snapshot(true);
  const view = render(status(running));
  expect(screen.getByRole('status')).toHaveTextContent('Working');
  view.rerender(status({ ...snapshot(), revision: 2 }));
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  view.rerender(status(running, 'other'));
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  view.rerender(status(running, 'chat', true));
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  view.rerender(status(null));
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});
