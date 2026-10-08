import { createElement } from 'react';
import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultDisplayState } from '../../../../spikes/mastra-code-sdk/node_modules/@mastra/core/dist/agent-controller/index.js';
import { AsyncQuestionAnswersProvider } from '../composer/AsyncQuestionReplyProvider';
import { asyncQuestionKey, canonicalQuestionAnswers, questionReplyClientId } from '../composer/asyncQuestionReplies';
import { TimelineItemRenderer } from '../timeline/renderers';
import type { TimelineItem } from '../timeline/state';
import type { ChatSnapshot } from './client';
import { timelinePresentation } from './presentation';

type Message = ChatSnapshot['messages'][number];
const questions = [{ title: 'Finish **login**?', options: ['Log in now', 'Continue'] }, { title: 'Anything else?', options: null }];
function question(messageId: string, callId = 'repeated-call'): Message {
  return { id: messageId, role: 'assistant', createdAt: new Date(0), content: { format: 2, parts: [{ type: 'tool-invocation',
    toolInvocation: { toolCallId: callId, toolName: 'request_user_input_async', state: 'result', args: { questions }, result: { accepted: true } } }] } };
}
function items(messages: Message[], display?: ChatSnapshot['display']): TimelineItem[] {
  return timelinePresentation({ messages, display, revision: 1, history: { earliest: null, hasOlder: false } }).rows.flatMap(row => row.type === 'item' ? [row.item] : []);
}
afterEach(cleanup);
describe('native asynchronous question presentation', () => {
  it('uses the shared read-only card and stable native message/call identity without inventing turns', async () => {
    const mapped = items([question('native-message')])[0];
    expect(mapped.kind).toBe('assistant_message');
    expect(mapped.asyncQuestions).toEqual([{ title: 'Finish **login**?', options: ['Log in now', 'Continue'] }, { title: 'Anything else?', options: [] }]);
    expect(mapped.serverItemId).toBe(JSON.stringify(['native-message', 'repeated-call']));
    expect(mapped.turnId).toBeNull();
    render(createElement(MantineProvider, null, createElement(TimelineItemRenderer, { item: mapped })));
    expect(await screen.findByText('login')).toBeVisible();
    expect(screen.getByText('Log in now')).toBeVisible();
    expect(screen.getByText('Anything else?')).toBeVisible();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByText(/accepted/)).not.toBeInTheDocument();
  });
  it('restores only explicitly correlated human answers across reload and separates repeated tool IDs', async () => {
    const messages = [question('first-message'), question('second-message')];
    const mapped = items(messages);
    expect(mapped[0].id).not.toBe(mapped[1].id);
    const key = asyncQuestionKey(mapped[0], 0), otherKey = asyncQuestionKey(mapped[1], 0);
    const clientId = questionReplyClientId(key);
    const reply: Message = { id: 'native-reply-id', role: 'signal', createdAt: new Date(1), content: { format: 2,
      parts: [{ type: 'text', text: 'Signed in' }], metadata: { signal: { id: 'native-reply-id', type: 'user', metadata: { clientId } } } } };
    const restored = items(structuredClone([...messages, reply]));
    expect(restored[2].clientId).toBe(clientId);
    expect(restored[2].id).not.toBe(clientId);
    expect(canonicalQuestionAnswers(restored)).toEqual({ [key]: 'Signed in' });
    expect(canonicalQuestionAnswers(restored)[otherKey]).toBeUndefined();
    render(createElement(MantineProvider, null, createElement(AsyncQuestionAnswersProvider, { items: restored, children: createElement(TimelineItemRenderer, { item: restored[0] }) })));
    fireEvent.click(screen.getAllByText('Input requested')[0]);
    expect(await screen.findByRole('blockquote')).toHaveTextContent('Signed in');
    const ordinary = structuredClone(reply); ordinary.content.metadata = { signal: { id: clientId, type: 'user' } };
    expect(canonicalQuestionAnswers(items([...messages, ordinary]))).toEqual({});
    const notification = structuredClone(reply); notification.content.metadata = { signal: { type: 'notification', metadata: { clientId } } };
    expect(canonicalQuestionAnswers(items([...messages, notification]))).toEqual({});
  });
  it('retains a successful saved card under sparse live completion and clears it on replacement or failure', () => {
    const message = question('saved-message'), display = defaultDisplayState();
    display.activeTools.set('repeated-call', { name: 'request_user_input_async', status: 'completed', args: undefined });
    const mapped = () => items([message], display)[0];
    expect(mapped().asyncQuestions).toHaveLength(2);
    display.activeTools.get('repeated-call')!.args = { questions: structuredClone(questions) };
    expect(mapped().asyncQuestions).toHaveLength(2);
    display.activeTools.get('repeated-call')!.args = { questions: [{ title: 'A different question' }] };
    expect(mapped().kind).toBe('dynamic_tool_call'); expect(mapped().asyncQuestions).toBeUndefined();
    display.activeTools.get('repeated-call')!.args = undefined;
    display.activeTools.get('repeated-call')!.result = { accepted: false };
    expect(mapped().kind).toBe('dynamic_tool_call'); expect(mapped().asyncQuestions).toBeUndefined();
    display.activeTools.get('repeated-call')!.result = undefined;
    display.activeTools.get('repeated-call')!.isError = true;
    expect(mapped().kind).toBe('dynamic_tool_call'); expect(mapped().asyncQuestions).toBeUndefined();
    display.activeTools.set('repeated-call', { name: 'custom_tool', status: 'completed', args: {}, result: { accepted: true } });
    expect(mapped().kind).toBe('dynamic_tool_call'); expect(mapped().asyncQuestions).toBeUndefined(); expect(mapped().serverItemId).toBeUndefined();
    display.activeTools.clear(); expect(mapped().asyncQuestions).toHaveLength(2);
  });
  it('requires accepted completion, valid arguments and a native message identity', () => {
    for (const failure of [
      { args: { questions: [] } }, { args: { questions: [{ title: ' ' }] } },
      { args: { questions: [{ title: 'Question', options: [42] }] } },
      { args: { questions: [{ title: 'Question', extra: true }] } }, { args: { questions, extra: true } }, { args: { questions: [{ title: 'Question', options: [] }] } },
      { result: null }, { result: { accepted: false } }, { state: 'call', result: undefined }, { isError: true },
    ]) {
      const message = question('invalid');
      const part = message.content.parts[0]; if (part.type !== 'tool-invocation') throw new Error('Missing fixture tool');
      Object.assign(part.toolInvocation, failure);
      const mapped = items([message])[0];
      expect(mapped.kind).toBe('dynamic_tool_call'); expect(mapped.asyncQuestions).toBeUndefined();
    }
    const display = defaultDisplayState();
    display.activeTools.set('orphan', { name: 'request_user_input_async', status: 'completed', args: { questions }, result: { accepted: true } });
    const orphan = items([], display)[0]; expect(orphan.kind).toBe('dynamic_tool_call'); expect(orphan.asyncQuestions).toBeUndefined();
  });
  it('uses a completed live result on the current native message before persisted history catches up', () => {
    const message = question('current-message');
    const part = message.content.parts[0]; if (part.type !== 'tool-invocation') throw new Error('Missing fixture tool');
    part.toolInvocation = { ...part.toolInvocation, state: 'call', result: undefined };
    const display = defaultDisplayState(); display.currentMessage = message;
    display.activeTools.set('repeated-call', { name: 'request_user_input_async', status: 'completed', args: undefined, result: { accepted: true } });
    expect(items([], display)[0].asyncQuestions).toHaveLength(2);
    expect(items([], display)[0].serverItemId).toBe(items([question('current-message')])[0].serverItemId);
  });
});
