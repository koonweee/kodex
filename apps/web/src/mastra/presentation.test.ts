import { nativeReadStateFixture, nativeQueueFixture, nativeSettingsFixture } from './testBuilders';
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { TimelineItemRenderer } from '../timeline/renderers';
import { defaultDisplayState } from '../../../../spikes/mastra-code-sdk/node_modules/@mastra/core/dist/agent-controller/index.js';
import { acceptsSnapshot, chatListEntry, timelinePresentation } from './presentation';
import type { Chat, ChatSnapshot } from './client';
function presentationItems(value: ChatSnapshot) {
  return timelinePresentation(value).rows.flatMap(row => row.type === 'activity' ? row.items : row.type === 'item' ? [row.item] : []);
}

function snapshot(): ChatSnapshot {
  return { readState: nativeReadStateFixture(), epoch: 'session-a', revision: 1, chat: { bindingId: 'binding', pinned: false, notificationsEnabled: true, id: 'chat', projectId: 'project', title: 'Chat', name: 'Chat', cwd: '/project' }, error: null, prompts: [], goal: null, queue: nativeQueueFixture(), settings: nativeSettingsFixture(),
    history: { earliest: 'user', hasOlder: true }, display: defaultDisplayState(), messages: [
      { id: 'user', role: 'user', createdAt: new Date(0), content: { format: 2, parts: [{ type: 'text', text: 'Hello' }] } },
      { id: 'assistant', role: 'assistant', createdAt: new Date(1), content: { format: 2, parts: [{ type: 'text', text: 'Old' }] } },
    ] };
}
describe('native chat presentation', () => {
  it('uses an exact current native prompt to show a suspended tool as waiting instead of failed', () => {
    const value = snapshot();
    value.messages[1].content.parts = [{ type: 'tool-invocation', toolInvocation: { toolCallId: 'plan-call', toolName: 'submit_plan', state: 'result', args: { path: 'plan.md' }, isError: true } }];
    value.display.activeTools.set('plan-call', { name: 'submit_plan', args: { path: 'plan.md' }, status: 'error', isError: true });
    const item = () => timelinePresentation(value).rows.flatMap(row => row.type === 'item' && row.item.id === 'plan-call' ? [row.item] : [])[0];
    const target = { sessionId: 'session', threadId: 'chat', resourceId: 'resource', runId: 'run', toolCallId: 'plan-call' };
    value.prompts = [{ kind: 'plan', target, path: 'plan.md' }];
    expect(item().status).toBe('approval_required');
    value.prompts = [{ kind: 'question', target, question: 'Different native tool' }];
    expect(item().status).toBe('failed');
    value.prompts = [];
    expect(item().status).toBe('failed');
  });
  it('maps persisted read-only history without requiring active session display state', () => {
    const value = snapshot();
    value.messages[1].content.parts = [{ type: 'tool-invocation', toolInvocation: { toolCallId: 'saved', toolName: 'write_file', state: 'result', args: { path: 'notes.txt', content: 'saved' }, result: 'Wrote 5 bytes to notes.txt' } }];
    const result = timelinePresentation({ messages: value.messages, history: value.history, revision: value.revision });
    const saved = result.rows.flatMap(row => row.type === 'item' && row.item.id === 'saved' ? [row.item] : []);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ kind: 'file_change', action: 'Write', path: 'notes.txt', status: 'completed', fileChangeOutcomeKnown: false, output: 'Wrote 5 bytes to notes.txt' });
    expect(result.hasOlderHistory).toBe(true);
  });
  it('converges sparse live file summaries with saved arguments/results and clears fields when the native type changes', () => {
    const value = snapshot();
    value.messages[1].content.parts = [{ type: 'tool-invocation', toolInvocation: { toolCallId: 'file', toolName: 'write_file', state: 'result', args: { path: 'notes.txt' }, result: 'Native saved write result' } }];
    const item = () => presentationItems(value).filter(item => item.id === 'file');
    value.display.activeTools.set('file', { name: 'write_file', args: undefined, status: 'completed' });
    expect(item()).toHaveLength(1);
    expect(item()[0]).toMatchObject({ kind: 'file_change', action: 'Write', path: 'notes.txt', output: 'Native saved write result', fileChangeOutcomeKnown: false });
    value.display.activeTools.get('file')!.result = 'Native live refusal';
    expect(item()[0].output).toBe('Native live refusal');
    value.display.activeTools.clear();
    expect(item()[0].output).toBe('Native saved write result');
    value.display.activeTools.set('file', { name: 'execute_command', args: { command: 'pwd' }, status: 'completed', result: '/project' });
    expect(item()[0]).toMatchObject({ kind: 'command_execution', command: 'pwd', commandOutcomeKnown: false });
    expect(item()[0].action).toBeUndefined();
    expect(item()[0].fileChangeOutcomeKnown).toBeUndefined();
    expect(item()[0].path).toBeUndefined();
    value.messages[1].content.parts = [{ type: 'tool-invocation', toolInvocation: { toolCallId: 'file', toolName: 'execute_command', state: 'result', args: { command: 'pwd' }, result: '/project' } }];
    value.display.activeTools.set('file', { name: 'view', args: { path: 'notes.txt' }, status: 'completed', result: 'Native read content' });
    expect(item()[0]).toMatchObject({ kind: 'file_change', action: 'Read', path: 'notes.txt' });
    expect(item()[0].command).toBeUndefined();
    expect(item()[0].commandOutcomeKnown).toBeUndefined();
    value.display.activeTools.set('file', { name: 'custom_tool', args: {}, status: 'running' });
    expect(item()[0].kind).toBe('dynamic_tool_call');
    expect(item()[0].output).toBe('');
    expect(item()[0].path).toBeUndefined();
    expect(item()[0].fileChangeOutcomeKnown).toBeUndefined();
  });
  it('replaces saved image presentation with live text file output without keeping stale image fields', () => {
    const value = snapshot();
    value.messages[1].content.parts = [{ type: 'tool-invocation', toolInvocation: { toolCallId: 'read', toolName: 'view', state: 'result', args: { path: 'picture.png' }, result: { __workspaceMedia: true, text: 'Saved image', mediaType: 'image/png', data: 'iVBORw0KGgo=' } } }];
    value.display.activeTools.set('read', { name: 'view', args: { path: 'notes.txt' }, status: 'running', partialResult: 'Native text read' });
    const item = timelinePresentation(value).rows.flatMap(row => row.type === 'item' && row.item.id === 'read' ? [row.item] : [])[0];
    expect(item).toMatchObject({ kind: 'file_change', action: 'Read', path: 'notes.txt', output: 'Native text read', fileChangeOutcomeKnown: false });
    expect(item.imageSrc).toBeUndefined();
  });
  it('shows a native replacement failure as a requested file operation with its complete result', () => {
    const value = snapshot();
    value.messages[1].content.parts = [{ type: 'tool-invocation', toolInvocation: { toolCallId: 'replace', toolName: 'string_replace_lsp', state: 'result', args: { path: 'README.md', old_string: 'absent', new_string: 'new' }, result: 'String not found in file\nNative diagnostic detail' } }];
    const item = timelinePresentation(value).rows.flatMap(row => row.type === 'item' && row.item.id === 'replace' ? [row.item] : [])[0];
    render(createElement(MantineProvider, null, createElement(TimelineItemRenderer, { item })));
    expect(screen.getByText('Replace README.md')).toBeVisible();
    expect(screen.getByText(/String not found in file/)).toHaveTextContent('Native diagnostic detail');
    expect(screen.queryByText(/Modified|files? changed|Success/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/File diff/)).not.toBeInTheDocument();
  });
  it('uses canonical history availability and the pane loading state', () => {
    const value = snapshot();
    expect(timelinePresentation(value).hasOlderHistory).toBe(true);
    expect(timelinePresentation(value).isLoadingOlderHistory).toBe(false);
    expect(timelinePresentation(value, true).isLoadingOlderHistory).toBe(true);
    value.history = { earliest: 'user', hasOlder: false };
    expect(timelinePresentation(value).hasOlderHistory).toBe(false);
  });
  it('replaces persisted content with the live message without duplicating it', () => {
    const value = snapshot();
    value.display = { ...value.display, isRunning: true, currentMessage: { ...value.messages[1], content: { format: 2, parts: [{ type: 'text', text: 'Streaming answer' }] } } };
    const rows = timelinePresentation(value).rows;
    expect(rows.map(row => row.type === 'item' && row.item.text)).toEqual(['Hello', 'Streaming answer']);
    expect(rows[1].type === 'item' && rows[1].item.status).toBe('running');
    expect(rows.every(row => row.turnId === null)).toBe(true);
  });
  it('renders native user-authored signals while keeping other signals out of the transcript', () => {
    const value = snapshot();
    value.messages[0] = { ...value.messages[0], role: 'signal', content: { format: 2, parts: [{ type: 'text', text: 'Native human input' }], metadata: { signal: { type: 'user' } } } };
    value.messages.push({ ...value.messages[0], id: 'notification', content: { format: 2, parts: [{ type: 'text', text: 'Internal notification' }], metadata: { signal: { type: 'notification' } } } });
    const items = timelinePresentation(value).rows.flatMap(row => row.type === 'item' ? [row.item] : []);
    expect(items.filter(item => item.kind === 'user_message').map(item => item.text)).toEqual(['Native human input']);
    expect(items.some(item => item.text === 'Internal notification')).toBe(false);
  });
  it('shows native tool input and results, replacing the same call with live state', () => {
    const value = snapshot();
    value.messages[1].content.parts = [{ type: 'tool-invocation', toolInvocation: { toolCallId: 'call', toolName: 'read_file', state: 'call', args: { path: 'README.md' } } }];
    value.display.activeTools.set('call', { name: 'read_file', args: { path: 'README.md' }, status: 'completed', result: 'contents' });
    const tools = presentationItems(value).filter(item => item.kind === 'dynamic_tool_call');
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ toolName: 'read_file', status: 'completed', output: 'contents' });
    expect(tools[0].argsSummary).toContain('README.md');
  });
  it('renders native stored tool results through the existing visible tool row', () => {
    const value = snapshot();
    value.messages[1].content.parts = [{ type: 'tool-invocation', toolInvocation: { toolCallId: 'read', toolName: 'view', state: 'result', args: { path: 'README.md' }, result: 'NATIVE_FILE_CONTENTS' } }];
    const item = timelinePresentation(value).rows.flatMap(row => row.type === 'item' && row.item.id === 'read' ? [row.item] : [])[0];
    render(createElement(MantineProvider, null, createElement(TimelineItemRenderer, { item })));
    expect(screen.getByText(/NATIVE_FILE_CONTENTS/)).toBeVisible();
  });
  it('shows streamed shell text then the full native terminal result without claiming success', () => {
    const value = snapshot();
    value.messages[1].content.parts = [{ type: 'tool-invocation', toolInvocation: { toolCallId: 'shell', toolName: 'execute_command', state: 'call', args: { command: 'false' } } }];
    value.display.activeTools.set('shell', { name: 'execute_command', args: { command: 'false' }, status: 'running', shellOutput: 'partial output' });
    const toolItem = () => presentationItems(value).filter(item => item.id === 'shell');
    const rendered = render(createElement(MantineProvider, null, createElement(TimelineItemRenderer, { item: toolItem()[0] })));
    expect(screen.getByText(/partial output/)).toBeVisible();
    value.display.activeTools.set('shell', { name: 'execute_command', args: { command: 'false' }, status: 'completed', shellOutput: 'partial output', result: 'partial output\nExit code: 1' });
    expect(toolItem()).toHaveLength(1);
    expect(toolItem()[0].output).toBe('partial output\nExit code: 1');
    rendered.rerender(createElement(MantineProvider, null, createElement(TimelineItemRenderer, { item: toolItem()[0] })));
    expect(screen.getByText(/Exit code: 1/)).toBeVisible();
    expect(screen.queryByText('Success', { exact: true })).not.toBeInTheDocument();
  });
  it('shows native media descriptions without dumping their encoded bytes into a generic result', () => {
    const value = snapshot();
    value.display.activeTools.set('image', { name: 'view', args: { path: 'sample.png' }, status: 'completed', result: { __workspaceMedia: true, text: 'Image read: sample.png', mediaType: 'image/png', data: 'ENCODED_BYTES' } });
    const item = timelinePresentation(value).rows.flatMap(row => row.type === 'item' && row.item.id === 'image' ? [row.item] : [])[0];
    render(createElement(MantineProvider, null, createElement(TimelineItemRenderer, { item })));
    expect(screen.getByText(/Image read: sample.png/)).toBeVisible();
    expect(screen.queryByText(/ENCODED_BYTES/)).not.toBeInTheDocument();
  });
  it('retains a stored result when a live tool summary has no output, including explicit null results', () => {
    const value = snapshot();
    value.messages[1].content.parts = [{ type: 'tool-invocation', toolInvocation: { toolCallId: 'stored', toolName: 'custom_tool', state: 'result', args: {}, result: { detail: 'STORED_RESULT' } } }];
    value.display.activeTools.set('stored', { name: 'custom_tool', args: {}, status: 'completed' });
    const toolItem = () => presentationItems(value).filter(item => item.id === 'stored')[0];
    expect(toolItem().resultSummary).toContain('STORED_RESULT');
    value.display.activeTools.get('stored')!.result = null;
    expect(toolItem().resultSummary).toBe('null');
    value.display.activeTools.clear();
    value.messages[1].content.parts = [{ type: 'tool-invocation', toolInvocation: { toolCallId: 'stored', toolName: 'custom_tool', state: 'result', args: {}, result: null } }];
    expect(toolItem().resultSummary).toBe('null');
  });
  it('opens actual native image data through the existing viewer in live and saved history', () => {
    const value = snapshot();
    const result = { __workspaceMedia: true, text: 'Read native image', mediaType: 'image/png', data: 'iVBORw0KGgo=' };
    value.messages[1].content.parts = [{ type: 'tool-invocation', toolInvocation: { toolCallId: 'image', toolName: 'view', state: 'result', args: { path: 'picture.bin' }, result } }];
    const item = () => timelinePresentation(value).rows.flatMap(row => row.type === 'item' && row.item.id === 'image' ? [row.item] : [])[0];
    expect(item().kind).toBe('image_view');
    const open = vi.fn();
    const rendered = render(createElement(MantineProvider, null, createElement(TimelineItemRenderer, { item: item(), threadId: 'chat', onImageOpen: open })));
    const image = rendered.container.querySelector('img');
    expect(image).toHaveAttribute('src', `data:image/png;base64,${result.data}`);
    fireEvent.click(screen.getByRole('button', { name: 'Open picture.bin' }));
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ src: `data:image/png;base64,${result.data}`, title: 'picture.bin' }));
    expect(screen.queryByText(/Prompt:/)).not.toBeInTheDocument();
    value.display.activeTools.set('image', { name: 'view', args: { path: 'picture.bin' }, status: 'completed', result });
    expect(item().imageSrc).toBe(`data:image/png;base64,${result.data}`);
    value.display.activeTools.get('image')!.result = { ...result, mediaType: 'IMAGE/PNG' };
    expect(item().imageSrc).toBe(`data:image/png;base64,${result.data}`);
    value.display.activeTools.get('image')!.result = undefined;
    expect(item().imageSrc).toBe(`data:image/png;base64,${result.data}`);
    value.display.activeTools.clear();
    expect(item().imageSrc).toBe(`data:image/png;base64,${result.data}`);
  });
  it('does not invent image previews from filenames, non-image media or failed tools', () => {
    for (const [result, isError] of [
      ['File not found: picture.png', false],
      [{ __workspaceMedia: true, text: 'PDF file', mediaType: 'application/pdf', data: 'PDF_BYTES' }, false],
      [{ __workspaceMedia: true, text: 'Image failure', mediaType: 'image/png', data: 'IMAGE_BYTES' }, true],
    ] as const) {
      const value = snapshot();
      value.display.activeTools.set('view', { name: 'view', args: { path: 'picture.png' }, status: isError ? 'error' : 'completed', result, isError });
      const item = timelinePresentation(value).rows.flatMap(row => row.type === 'item' && row.item.id === 'view' ? [row.item] : [])[0];
      expect(item.kind).toBe('file_change');
      expect(item.fileChangeOutcomeKnown).toBe(false);
      expect(item.imageSrc).toBeUndefined();
    }
  });
  it.each([
    { result: null, isError: false },
    { result: 'No image returned', isError: false },
    { result: undefined, isError: true },
  ])('clears a saved image when live output replaces it: %j', ({ result, isError }) => {
    const value = snapshot();
    value.messages[1].content.parts = [{ type: 'tool-invocation', toolInvocation: { toolCallId: 'image', toolName: 'view', state: 'result', args: { path: '/project/picture.png' }, result: { __workspaceMedia: true, text: 'Read image', mediaType: 'image/png', data: 'iVBORw0KGgo=' } } }];
    value.display.activeTools.set('image', { name: 'view', args: { path: '/project/picture.png' }, status: isError ? 'error' : 'completed', result, isError });
    const item = timelinePresentation(value).rows.flatMap(row => row.type === 'item' && row.item.id === 'image' ? [row.item] : [])[0];
    expect(item.kind).toBe('file_change');
    expect(item.imageSrc).toBeUndefined();
    expect(item.path).toBe('/project/picture.png');
    expect(item.status).toBe(isError ? 'failed' : 'completed');
  });
  it('renders native shell output without treating tool completion as command success', () => {
    const value = snapshot();
    value.messages[1].content.parts = [{ type: 'tool-invocation', toolInvocation: { toolCallId: 'shell', toolName: 'execute_command', state: 'result', args: { command: 'exit 7' }, result: 'Exit code: 7' } }];
    const item = () => presentationItems(value).filter(item => item.id === 'shell')[0];
    const rendered = render(createElement(MantineProvider, null, createElement(TimelineItemRenderer, { item: item() })));
    expect(screen.getByText('Shell')).toBeInTheDocument();
    expect(screen.getByText('$ exit 7')).toBeInTheDocument();
    expect(screen.getByText('Exit code: 7')).toBeInTheDocument();
    expect(screen.getByText('Finished')).toBeInTheDocument();
    expect(screen.queryByText('Success')).not.toBeInTheDocument();
    value.display.activeTools.set('shell', { name: 'execute_command', args: { command: 'exit 7' }, status: 'completed', shellOutput: 'partial output', result: 'Exit code: 7' });
    expect(item().kind).toBe('command_execution');
    expect(item().command).toBe('exit 7');
    expect(item().output).toBe('Exit code: 7');
    value.display.activeTools.get('shell')!.isError = true;
    rendered.rerender(createElement(MantineProvider, null, createElement(TimelineItemRenderer, { item: item() })));
    expect(screen.getByText('Failed')).toBeInTheDocument();
  });
  it('rejects stale snapshots within an epoch and accepts restarted sessions', () => {
    expect(acceptsSnapshot({ epoch: 'a', revision: 7 }, { epoch: 'a', revision: 6 })).toBe(false);
    expect(acceptsSnapshot({ epoch: 'a', revision: 7 }, { epoch: 'a', revision: 7 })).toBe(false);
    expect(acceptsSnapshot({ epoch: 'a', revision: 7 }, { epoch: 'b', revision: 0 })).toBe(true);
    expect(acceptsSnapshot(null, { epoch: 'a', revision: 0 })).toBe(true);
  });
});

describe('native sidebar read state', () => {
  it('projects only a known unseen native head, preserving running precedence', () => {
    const chat = { id: 'chat', bindingId: 'binding', title: 'Chat', name: null, projectId: null, cwd: '/project', pinned: false, notificationsEnabled: true, isRunning: false,
      readState: { epoch: 'native', revision: 1, head: { runId: 'run', messageId: 'answer', reason: 'complete' }, seen: false } } satisfies Chat;
    expect(chatListEntry(chat).unreadCompletedAgentTurn).toBe(true);
    expect(chatListEntry({ ...chat, readState: { ...chat.readState, seen: true } }).unreadCompletedAgentTurn).toBe(false);
    expect(chatListEntry({ ...chat, readState: { ...chat.readState, seen: null } }).unreadCompletedAgentTurn).toBe(false);
    expect(chatListEntry({ ...chat, readState: { ...chat.readState, head: null } }).unreadCompletedAgentTurn).toBe(false);
    expect(chatListEntry({ ...chat, isRunning: true })).toMatchObject({ isRunning: true, unreadCompletedAgentTurn: true });
  });
});
