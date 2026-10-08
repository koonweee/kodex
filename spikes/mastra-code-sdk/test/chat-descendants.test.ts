import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectChatDescendants } from '../src/chat-descendants.js';
import type { NativeThread } from '../src/chat-projects.js';

const projectPath = '/owned/project';
const thread = (id: string, resourceId: string, metadata: Record<string, unknown>): NativeThread => ({
  id, resourceId, title: id, createdAt: new Date(0), updatedAt: new Date(0), metadata,
});
const parent = thread('root', 'root-resource', { projectPath });
const fresh = (id: string, resourceId: string, parent: NativeThread, extra: Record<string, unknown> = {}) => thread(id, resourceId, {
  projectPath, kodexChild: '1', parentThreadId: parent.id, parentResourceId: parent.resourceId,
  parentSessionScope: '', parentTaskId: `${id}-task`, ...extra,
});
const fork = (id: string, parent: NativeThread, extra: Record<string, unknown> = {}) => thread(id, parent.resourceId, {
  forkedSubagent: true, parentThreadId: parent.id, ...extra,
});

test('native descendants follow validated mixed spawn edges once and exclude ordinary forks', () => {
  const child = fresh('child', 'child-resource', parent);
  const nested = fork('nested', child);
  const grandchild = fresh('grandchild', 'grandchild-resource', nested);
  const ordinary = thread('ordinary', parent.resourceId, { parentThreadId: parent.id, projectPath });
  const unreachable = fork('ordinary-descendant', ordinary);
  const rootCycle = fresh('root', parent.resourceId, grandchild);
  const disconnectedA = thread('cycle-a', 'cycle-resource', { forkedSubagent: true, parentThreadId: 'cycle-b' });
  const disconnectedB = thread('cycle-b', 'cycle-resource', { forkedSubagent: true, parentThreadId: 'cycle-a' });
  const actual = collectChatDescendants(parent, [grandchild, nested, child, child, ordinary, unreachable, rootCycle, disconnectedA, disconnectedB], projectPath);
  assert.deepEqual(actual.map(row => [row.thread.id, row.kind, row.parentThreadId]), [
    ['child', 'child', 'root'], ['nested', 'fork', 'child'], ['grandchild', 'child', 'nested'],
  ]);
});

test('invalid native spawn edges cannot admit their otherwise valid descendants', () => {
  const child = fresh('valid', 'valid-resource', parent);
  const cases = [
    fresh('wrong-parent-resource', 'new-resource-a', parent, { parentResourceId: 'foreign-resource' }),
    fresh('same-resource', parent.resourceId, parent),
    fresh('wrong-project', 'new-resource-b', parent, { projectPath: '/foreign/project' }),
    fresh('missing-project', 'new-resource-c', parent, { projectPath: undefined }),
    fresh('wrong-scope', 'new-resource-d', parent, { parentSessionScope: 'scoped' }),
    fresh('wrong-version', 'new-resource-e', parent, { kodexChild: 'future' }),
    fresh('missing-task', 'new-resource-f', parent, { parentTaskId: '' }),
    thread('wrong-fork-resource', 'foreign-resource', { forkedSubagent: true, parentThreadId: parent.id }),
    fork('wrong-fork-project', parent, { projectPath: '/foreign/project' }),
  ];
  const descendants = cases.map((invalid, index) => fresh(`invalid-leaf-${index}`, `invalid-leaf-resource-${index}`, invalid));
  assert.deepEqual(collectChatDescendants(parent, [...cases, ...descendants, child], projectPath).map(row => row.thread.id), ['valid']);
  assert.deepEqual(collectChatDescendants(parent, [child], '/foreign/project'), []);
});
