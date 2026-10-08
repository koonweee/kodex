import { nativeQueueFixture, nativeSettingsFixture } from './testBuilders';
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { TimelineItemRenderer } from '../timeline/renderers';
import { defaultDisplayState } from '../../../../spikes/mastra-code-sdk/node_modules/@mastra/core/dist/agent-controller/index.js';
import { acceptsSnapshot, timelinePresentation } from './presentation';
import type { ChatSnapshot } from './client';

function snapshot(): ChatSnapshot {
  return { epoch: 'session-a', revision: 1, chat: { pinned: false, notificationsEnabled: true, id: 'chat', projectId: 'project', title: 'Chat', name: 'Chat', cwd: '/project' }, error: null, goal: null, queue: nativeQueueFixture(), settings: nativeSettingsFixture(),
    history: { earliest: 'user', hasOlder: true }, display: defaultDisplayState(), messages: [
      { id: 'user', role: 'user', createdAt: new Date(0), content: { format: 2, parts: [{ type: 'text', text: 'Hello' }] } },
      { id: 'assistant', role: 'assistant', createdAt: new Date(1), content: { format: 2, parts: [{ type: 'text', text: 'Old' }] } },
    ] };
}
describe('native chat presentation', () => {
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
    const rows = timelinePresentation(value).rows;
    const tools = rows.flatMap(row => row.type === 'item' && row.item.kind === 'dynamic_tool_call' ? [row.item] : []);
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
    const toolItem = () => timelinePresentation(value).rows.flatMap(row => row.type === 'item' && row.item.id === 'shell' ? [row.item] : []);
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
    const toolItem = () => timelinePresentation(value).rows.flatMap(row => row.type === 'item' && row.item.id === 'stored' ? [row.item] : [])[0];
    expect(toolItem().resultSummary).toContain('STORED_RESULT');
    value.display.activeTools.get('stored')!.result = null;
    expect(toolItem().resultSummary).toBe('null');
    value.display.activeTools.clear();
    value.messages[1].content.parts = [{ type: 'tool-invocation', toolInvocation: { toolCallId: 'stored', toolName: 'custom_tool', state: 'result', args: {}, result: null } }];
    expect(toolItem().resultSummary).toBe('null');
  });
  it('rejects stale snapshots within an epoch and accepts restarted sessions', () => {
    expect(acceptsSnapshot({ epoch: 'a', revision: 7 }, { epoch: 'a', revision: 6 })).toBe(false);
    expect(acceptsSnapshot({ epoch: 'a', revision: 7 }, { epoch: 'a', revision: 7 })).toBe(false);
    expect(acceptsSnapshot({ epoch: 'a', revision: 7 }, { epoch: 'b', revision: 0 })).toBe(true);
    expect(acceptsSnapshot(null, { epoch: 'a', revision: 0 })).toBe(true);
  });
});
