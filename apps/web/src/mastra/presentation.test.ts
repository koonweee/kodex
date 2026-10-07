import { nativeQueueFixture, nativeSettingsFixture } from './testBuilders';
import { describe, expect, it } from 'vitest';
import { defaultDisplayState } from '../../../../spikes/mastra-code-sdk/node_modules/@mastra/core/dist/agent-controller/index.js';
import { acceptsSnapshot, timelinePresentation } from './presentation';
import type { ChatSnapshot } from './client';

function snapshot(): ChatSnapshot {
  return { epoch: 'session-a', revision: 1, chat: { pinned: false, notificationsEnabled: true, id: 'chat', projectId: 'project', title: 'Chat', name: 'Chat', cwd: '/project' }, error: null, goal: null, queue: nativeQueueFixture(), settings: nativeSettingsFixture(),
    display: defaultDisplayState(), messages: [
      { id: 'user', role: 'user', createdAt: new Date(0), content: { format: 2, parts: [{ type: 'text', text: 'Hello' }] } },
      { id: 'assistant', role: 'assistant', createdAt: new Date(1), content: { format: 2, parts: [{ type: 'text', text: 'Old' }] } },
    ] };
}
describe('native chat presentation', () => {
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
  it('rejects stale snapshots within an epoch and accepts restarted sessions', () => {
    expect(acceptsSnapshot({ epoch: 'a', revision: 7 }, { epoch: 'a', revision: 6 })).toBe(false);
    expect(acceptsSnapshot({ epoch: 'a', revision: 7 }, { epoch: 'a', revision: 7 })).toBe(false);
    expect(acceptsSnapshot({ epoch: 'a', revision: 7 }, { epoch: 'b', revision: 0 })).toBe(true);
    expect(acceptsSnapshot(null, { epoch: 'a', revision: 0 })).toBe(true);
  });
});
