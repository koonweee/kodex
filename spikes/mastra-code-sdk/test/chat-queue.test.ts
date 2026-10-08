import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NativeSession } from '../src/runtime.js';
import type { AgentMessageInput } from '@mastra/core/agent';
import type { ChatInput } from '../src/chat-input.js';
import { createChatQueue } from '../src/chat-queue.js';

function fixture(prepareInput?: (input: ChatInput) => Promise<AgentMessageInput>) {
  let next = 0, setting = 'old', fast = false, throwAfter = false, rejectAcceptance = false;
  let preparation: Promise<void> = Promise.resolve();
  let cancelledOnly: string[] | undefined;
  let externalPending = 0;
  let receipts: unknown[] = [];
  let receiptRead: Promise<void> = Promise.resolve();
  let throwCancel = false;
  let steering: Promise<void> = Promise.resolve();
  let action: 'deliver' | 'blocked' | 'persist' | 'discard' = 'deliver';
  const submitted: Array<{ id: string; text: AgentMessageInput; options: unknown }> = [];
  const steered: unknown[] = []; let aborts = 0, cancellations = 0;
  let changed: () => void = () => undefined;
  const pending = new Set<string>();
  const listeners = new Set<(event: { type: string; message?: { id: string }; count?: number }) => void>();
  const agent = {
    queueMessage(text: AgentMessageInput, options: unknown) {
      const id = `native-${++next}`;
      submitted.push({ id, text, options }); pending.add(id);
      if (throwAfter) { throwAfter = false; throw new Error('credential-bearing internal error'); }
      const accepted = rejectAcceptance ? Promise.reject(new Error('secret acknowledgment error')) : Promise.resolve({ action, runId: 'fixture-run', reason: 'thread-blocked' });
      if (action !== 'deliver') pending.delete(id);
      rejectAcceptance = false; action = 'deliver';
      return { signal: { id }, accepted };
    },
    async getMemory() { return { storage: { getStore: async () => ({ listMessagesById: async () => { await receiptRead; return { messages: receipts }; } }) } }; },
    cancelQueuedMessages({ signalIds }: { signalIds: string[] }) {
      cancellations++;
      const cancelledSignalIds = signalIds.filter(id => pending.has(id) && (!cancelledOnly || cancelledOnly.includes(id)));
      for (const id of cancelledSignalIds) pending.delete(id);
      if (throwCancel) throw new Error('sensitive cancellation callback');
      return { cancelledSignalIds };
    },
  };
  const session = {
    thread: { getId: () => 'thread', getSetting: async () => fast }, identity: { getResourceId: () => 'resource' },
    machinery: { getAgent: () => agent, buildRequestContext: async () => { const values = new Map<string, unknown>(); return { set: (key: string, value: unknown) => values.set(key, value), get: (key: string) => values.get(key) }; },
      buildStreamOptions: async (args: { requestContext: unknown }) => { await preparation; return { setting, requestContext: args.requestContext }; } },
    ensureFollowUpBinding() {},
    displayState: { get: () => ({ queuedFollowUps: pending.size + externalPending }) },
    subscribe(callback: (event: { type: string; message?: { id: string }; count?: number }) => void) { listeners.add(callback); return () => listeners.delete(callback); },
    steer: () => steering,
    abort: () => { aborts++; },
    sendSignal: (input: unknown) => { steered.push(input); return { id: 'native-steer', accepted: steering.then(() => ({ accepted: true, action: 'wake' })) }; },
  } as unknown as NativeSession;
  const queue = createChatQueue(session, { epoch: 'fixture', onChanged: () => changed(), ...(prepareInput && { prepareInput }) });
  return { queue, submitted, steered, get aborts() { return aborts; }, get cancellations() { return cancellations; },
    nextChange() { return new Promise<void>(resolve => { changed = resolve; }); },
    admit(id: string) { pending.delete(id); for (const listener of listeners) listener({ type: 'message_start', message: { id } }); },
    set setting(value: string) { setting = value; }, set fast(value: boolean) { fast = value; },
    set steering(value: Promise<void>) { steering = value; },
    set action(value: 'deliver' | 'blocked' | 'persist' | 'discard') { action = value; }, set throwAfter(value: boolean) { throwAfter = value; },
    set rejectAcceptance(value: boolean) { rejectAcceptance = value; },
    set cancelledOnly(value: string[] | undefined) { cancelledOnly = value; },
    set throwCancel(value: boolean) { throwCancel = value; },
    set receipts(value: unknown[]) { receipts = value; },
    set externalPending(value: number) { externalPending = value; for (const listener of listeners) listener({ type: 'follow_up_queued', count: pending.size + value }); },
    holdReceiptRead() { let release!: () => void; receiptRead = new Promise<void>(resolve => { release = resolve; }); return release; },
    holdPreparation() { let release!: () => void; preparation = new Promise<void>(resolve => { release = resolve; }); return release; },
  };
}
const text = (text: string) => ({ text });

test('middle edit preserves original prefix and suffix settings with stable public identities', async () => {
  const f = fixture(); const ids: string[] = [];
  for (const value of ['A', 'B', 'C']) ids.push((await f.queue.enqueue(text(value))).rowId);
  const before = f.queue.snapshot(); f.setting = 'new';
  const result = await f.queue.edit({ id: ids[1]!, input: text('B edited'), revision: before.revision });
  assert.equal(result.outcome, 'applied');
  assert.deepEqual(result.snapshot.rows.map(row => row.id), ids);
  assert.equal(result.snapshot.rows[0]!.nativeSignalId, before.rows[0]!.nativeSignalId);
  assert.deepEqual(f.submitted.map(row => ({ text: row.text, setting: (row.options as { ifIdle: { streamOptions: { setting: string } } }).ifIdle.streamOptions.setting })),
    [{ text: 'A', setting: 'old' }, { text: 'B', setting: 'old' }, { text: 'C', setting: 'old' }, { text: 'B edited', setting: 'new' }, { text: 'C', setting: 'old' }]);
  assert.equal(JSON.stringify(result).includes('streamOptions'), false);
  result.snapshot.rows[0]!.input.text = 'mutated';
  assert.equal(f.queue.snapshot().rows[0]!.input.text, 'A');
});

test('revision is rechecked after async preparation; stale clients cannot replay admitted rows', async () => {
  const f = fixture(); await f.queue.enqueue(text('A')); const b = await f.queue.enqueue(text('B'));
  const before = f.queue.snapshot(), release = f.holdPreparation();
  const editing = f.queue.edit({ id: b.rowId, input: text('B edited'), revision: before.revision });
  await Promise.resolve(); await Promise.resolve(); f.admit(before.rows[0]!.nativeSignalId!); release();
  assert.equal((await editing).outcome, 'conflict');
  assert.deepEqual(f.submitted.map(row => row.text), ['A', 'B']);
  assert.equal((await f.queue.remove({ id: b.rowId, revision: before.revision })).outcome, 'conflict');
});

test('partial cancellation restores only confirmed tail without applying stale edits', async () => {
  const f = fixture(); const a = await f.queue.enqueue(text('A')), b = await f.queue.enqueue(text('B'));
  const before = f.queue.snapshot(); f.cancelledOnly = [before.rows[1]!.nativeSignalId!];
  const result = await f.queue.reorder({ ids: [b.rowId, a.rowId], revision: before.revision });
  assert.equal(result.outcome, 'conflict'); assert.deepEqual(f.submitted.map(row => row.text), ['A', 'B', 'B']);
  assert.equal(result.snapshot.rows.find(row => row.id === a.rowId)?.status, 'uncertain');
  assert.equal(result.snapshot.rows.find(row => row.id === b.rowId)?.status, 'queued');
});

test('post-enqueue throw is uncertain, never-attempted tail recoverable, neither auto-replays', async () => {
  const f = fixture(); const a = await f.queue.enqueue(text('A')), b = await f.queue.enqueue(text('B'));
  const before = f.queue.snapshot(); f.throwAfter = true;
  const result = await f.queue.edit({ id: a.rowId, input: text('A edited'), revision: before.revision });
  assert.equal(result.outcome, 'uncertain');
  assert.deepEqual(result.snapshot.rows.map(row => [row.input.text, row.status, row.nativeSignalId]), [['A edited', 'uncertain', null], ['B', 'recoverable', null]]);
  assert.equal(JSON.stringify(result).includes('credential'), false);
  f.admit(f.submitted.at(-1)!.id); assert.equal(f.queue.snapshot().rows[0]!.status, 'uncertain');
  await f.queue.dismiss({ id: a.rowId, revision: f.queue.snapshot().revision });
  assert.deepEqual(f.submitted.map(row => row.text), ['A', 'B', 'A edited']);
  assert.equal(f.queue.snapshot().rows[0]!.id, b.rowId);
});

test('ambiguous acknowledgment retains native ID until exact admission without replay', async () => {
  const f = fixture(); f.rejectAcceptance = true; const result = await f.queue.enqueue(text('A'));
  assert.equal(result.outcome, 'uncertain'); assert.equal(result.snapshot.rows[0]!.status, 'uncertain');
  f.admit(result.snapshot.rows[0]!.nativeSignalId!); assert.deepEqual(f.queue.snapshot().rows, []);
  assert.equal(f.submitted.length, 1);
});

test('reordering retains each original Fast context; editing text captures a fresh context', async () => {
  const f = fixture(); f.fast = true;
  const a = await f.queue.enqueue(text('A')); f.fast = false;
  const b = await f.queue.enqueue(text('B'));
  await f.queue.reorder({ ids: [b.rowId, a.rowId], revision: f.queue.snapshot().revision });
  await f.queue.edit({ id: a.rowId, input: text('A edited'), revision: f.queue.snapshot().revision });
  const contexts = f.submitted.map(row => (row.options as { ifIdle: { streamOptions: { requestContext: { get(key: string): unknown } } } }).ifIdle.streamOptions.requestContext);
  assert.deepEqual(contexts.map(context => context.get('kodex.fast')), [true, false, false, true, false]);
  assert.equal(contexts[3], contexts[0], 'unchanged row keeps its captured context');
  assert.notEqual(contexts[4], contexts[0], 'edited text is a fresh submission');
});

test('native steering acknowledges promptly, does not hold command gate, and exposes rejection as uncertain', async () => {
  const f = fixture(); const a = await f.queue.enqueue(text('A'));
  let reject!: (error: Error) => void;
  f.steering = new Promise<void>((_, fail) => { reject = fail; });
  const steered = await f.queue.steer({ id: a.rowId, revision: f.queue.snapshot().revision });
  assert.equal(steered.snapshot.rows[0]!.status, 'steering');
  assert.equal((await f.queue.dismiss({ id: a.rowId, revision: f.queue.snapshot().revision })).outcome, 'conflict');
  await f.queue.enqueue(text('B'));
  const changed = f.nextChange(); reject(new Error('private native failure')); await changed;
  assert.equal(f.queue.snapshot().rows.find(row => row.id === a.rowId)?.status, 'uncertain');
  assert.equal(JSON.stringify(f.queue.snapshot()).includes('private'), false);
  assert.deepEqual(f.submitted.map(row => row.text), ['A', 'B']);
});

test('disposal leaves native accepted work alone and rejects pending preparation without another native submission', async () => {
  const f = fixture(); await f.queue.enqueue(text('A'));
  const release = f.holdPreparation(); const pending = f.queue.enqueue(text('B'));
  await Promise.resolve(); await Promise.resolve(); f.queue.dispose(); release();
  await assert.rejects(pending, /Native queue preparation failed/);
  assert.deepEqual(f.submitted.map(row => row.text), ['A']);
  assert.deepEqual(f.queue.snapshot().rows, []);
});

test('a cancellation callback throw after native mutation never restores inputs without confirmation', async () => {
  const f = fixture(); const a = await f.queue.enqueue(text('A')); await f.queue.enqueue(text('B'));
  const before = f.queue.snapshot(); f.throwCancel = true;
  const result = await f.queue.edit({ id: a.rowId, input: text('A edited'), revision: before.revision });
  assert.equal(result.outcome, 'uncertain');
  assert.deepEqual(result.snapshot.rows.map(row => [row.input.text, row.status, row.nativeSignalId]), before.rows.map(row => [row.input.text, 'uncertain', row.nativeSignalId]));
  assert.deepEqual(f.submitted.map(row => row.text), ['A', 'B']);
  assert.equal((await f.queue.reorder({ ids: result.snapshot.rows.map(row => row.id), revision: result.snapshot.revision })).outcome, 'conflict');
  assert.equal(JSON.stringify(result).includes('sensitive'), false);
});

test('the native accepted union never reports blocked, discarded or memory-only persistence as delivered queue work', async () => {
  for (const action of ['blocked', 'discard', 'persist'] as const) {
    const f = fixture(); f.action = action;
    const result = await f.queue.enqueue(text(`INPUT_${action}`));
    assert.equal(result.outcome, 'uncertain', `${action} is not native queue admission`);
    assert.equal(result.snapshot.rows[0]!.status, action === 'persist' ? 'uncertain' : 'recoverable');
    assert.equal(result.snapshot.rows[0]!.nativeSignalId, action === 'persist' ? f.submitted[0]!.id : null);
    assert.equal(f.submitted.length, 1, 'negative decisions never retry automatically');
    assert.equal((await f.queue.edit({ id: result.rowId, input: text('RETRY'), revision: result.snapshot.revision })).outcome, 'conflict');
    await f.queue.dismiss({ id: result.rowId, revision: f.queue.snapshot().revision });
    assert.equal(f.submitted.length, 1, 'only an explicit new input submission may retry');
  }
});

function receipt(id: string) { return { id, threadId: 'thread', resourceId: 'resource', role: 'signal', content: { parts: [], metadata: { signal: { id, type: 'user' } } } }; }
test('reconciliation uses exact scoped receipt identity and never absence/text to establish admission', async () => {
  const f = fixture(); f.rejectAcceptance = true;
  const submitted = await f.queue.enqueue(text('A'));
  const row = submitted.snapshot.rows[0]!;
  for (const invalid of [[], [receipt('unrelated')], [{ ...receipt(row.nativeSignalId!), threadId: 'other-thread' }], [{ ...receipt(row.nativeSignalId!), resourceId: 'other-resource' }], [{ ...receipt(row.nativeSignalId!), role: 'assistant' }], [receipt(row.nativeSignalId!), receipt(row.nativeSignalId!)]]) {
    f.receipts = invalid;
    const unresolved = await f.queue.reconcile({ id: row.id, revision: f.queue.snapshot().revision });
    assert.equal(unresolved.outcome, 'uncertain');
    assert.equal(unresolved.snapshot.rows[0]!.status, 'uncertain');
  }
  f.receipts = [receipt(row.nativeSignalId!)];
  const resolved = await f.queue.reconcile({ id: row.id, revision: f.queue.snapshot().revision });
  assert.equal(resolved.outcome, 'applied'); assert.deepEqual(resolved.snapshot.rows, []);
  assert.equal(f.submitted.length, 1);
});

test('known memory-only persistence cannot settle through a lookalike live event or exact stored receipt', async () => {
  const f = fixture(); f.action = 'persist';
  const submitted = await f.queue.enqueue(text('STORED_WITHOUT_EXECUTION'));
  const row = submitted.snapshot.rows[0]!;
  f.receipts = [receipt(row.nativeSignalId!)]; f.admit(row.nativeSignalId!);
  assert.equal(f.queue.snapshot().rows[0]?.status, 'uncertain');
  assert.equal((await f.queue.reconcile({ id: row.id, revision: f.queue.snapshot().revision })).outcome, 'uncertain');
  assert.equal(f.submitted.length, 1);
});

test('reconciliation fences native read overlap against a newer canonical queue revision', async () => {
  const f = fixture(); f.rejectAcceptance = true;
  const submitted = await f.queue.enqueue(text('A')); const row = submitted.snapshot.rows[0]!;
  f.receipts = [receipt(row.nativeSignalId!)]; const release = f.holdReceiptRead();
  const resolving = f.queue.reconcile({ id: row.id, revision: submitted.snapshot.revision });
  await Promise.resolve(); await Promise.resolve(); f.externalPending = 1; release();
  assert.equal((await resolving).outcome, 'conflict');
  assert.equal(f.queue.snapshot().rows[0]!.status, 'uncertain');
});

test('unknown native pending coverage blocks edit/reorder but exact-ID remove remains available', async () => {
  const f = fixture(); const submitted = await f.queue.enqueue(text('A'));
  const previous = f.queue.snapshot(); f.externalPending = 1;
  const partial = f.queue.snapshot();
  assert.equal(partial.nativeCount, 2); assert.equal(partial.partial, true); assert.ok(partial.revision > previous.revision);
  assert.equal((await f.queue.edit({ id: submitted.rowId, input: text('A edited'), revision: partial.revision })).outcome, 'conflict');
  assert.equal((await f.queue.reorder({ ids: [submitted.rowId], revision: partial.revision })).outcome, 'conflict');
  assert.equal((await f.queue.remove({ id: submitted.rowId, revision: partial.revision })).outcome, 'applied');
  assert.equal(f.queue.snapshot().nativeCount, 1); assert.deepEqual(f.queue.snapshot().rows, []);
});


const attachment = { id: 'upload', fileName: 'notes.txt', extension: 'txt', relativePath: '.kodex/uploads/thread/upload/notes.txt', absolutePath: '/project/.kodex/uploads/thread/upload/notes.txt', mimeType: 'text/plain', sizeBytes: 4 };
const image = { id: 'image', fileName: 'pixel.png', path: '/project/images/pixel.png', mimeType: 'image/png', sizeBytes: 8 };
test('queued attachments and materialized parts are immutable; text edits preserve attachments and reorder does not reread them', async () => {
  const prepared: AgentMessageInput = { contents: [{ type: 'text', text: 'FIRST' }, { type: 'file', data: 'aW1hZ2U=', mediaType: 'image/png', filename: 'pixel.png' }], metadata: { private: 'native-metadata' } };
  const calls: ChatInput[] = [];
  const f = fixture(async value => { calls.push(structuredClone(value)); return { ...prepared, contents: [{ type: 'text', text: value.text }, ...(typeof prepared !== 'string' && !Array.isArray(prepared) && Array.isArray(prepared.contents) ? prepared.contents.slice(1) : [])] }; });
  const caller = { text: 'FIRST', images: [structuredClone(image)], files: [structuredClone(attachment)] };
  const pending = f.queue.enqueue(caller); caller.images[0].fileName = 'caller mutation'; caller.files[0].relativePath = 'caller mutation';
  const a = await pending; const b = await f.queue.enqueue(text('SECOND'));
  assert.equal(calls[0]?.images?.[0]?.fileName, 'pixel.png'); assert.equal(calls[0]?.files?.[0]?.relativePath, attachment.relativePath);
  const snapshot = f.queue.snapshot(); const publicInput = snapshot.rows[0]!.input as ChatInput;
  assert.deepEqual(publicInput.images, [image]); assert.deepEqual(publicInput.files, [attachment]);
  publicInput.images![0].fileName = 'snapshot mutation'; publicInput.files![0].relativePath = 'snapshot mutation';
  assert.equal(JSON.stringify(snapshot).includes('aW1hZ2U='), false); assert.equal(JSON.stringify(snapshot).includes('native-metadata'), false);
  const edited = await f.queue.edit({ id: a.rowId, input: text('FIRST_EDITED'), revision: f.queue.snapshot().revision });
  assert.equal(edited.outcome, 'applied'); assert.deepEqual(calls.at(-1)?.images, [image]); assert.deepEqual(calls.at(-1)?.files, [attachment]);
  const lastCallCount = calls.length;
  const contents = typeof prepared !== 'string' && !Array.isArray(prepared) ? prepared.contents : undefined;
  if (Array.isArray(contents) && contents[1]?.type === 'file') contents[1].data = 'mutated native bytes';
  assert.equal((await f.queue.reorder({ ids: [b.rowId, a.rowId], revision: f.queue.snapshot().revision })).outcome, 'applied');
  assert.equal(calls.length, lastCallCount); assert.ok(JSON.stringify(f.submitted.at(-1)?.text).includes('aW1hZ2U='));
  let finish!: () => void; f.steering = new Promise<void>(resolve => { finish = resolve; });
  const steered = await f.queue.steer({ id: a.rowId, revision: f.queue.snapshot().revision });
  assert.equal(steered.snapshot.rows.find(row => row.id === a.rowId)?.status, 'steering'); assert.equal(f.aborts, 1);
  assert.ok(JSON.stringify(f.steered).includes('aW1hZ2U=')); assert.equal(JSON.stringify(f.steered).includes('mutated native bytes'), false);
  finish(); await Promise.resolve(); await Promise.resolve();
});

test('attachment-only queue input and blank text edits are valid only for a row retaining authoritative attachments', async () => {
  const f = fixture(async value => ({ contents: value.text || 'native attachment content' }));
  const a = await f.queue.enqueue({ text: '', files: [attachment] });
  assert.equal(a.outcome, 'applied');
  await f.queue.edit({ id: a.rowId, input: text('Added text'), revision: f.queue.snapshot().revision });
  const blanked = await f.queue.edit({ id: a.rowId, input: text(''), revision: f.queue.snapshot().revision });
  assert.equal(blanked.outcome, 'applied'); assert.deepEqual((blanked.snapshot.rows[0]!.input as ChatInput).files, [attachment]);
  const plain = await f.queue.enqueue(text('Plain')); const before = f.cancellations;
  await assert.rejects(f.queue.edit({ id: plain.rowId, input: text(''), revision: f.queue.snapshot().revision }), /text|attachments/);
  assert.equal(f.cancellations, before);
});

test('attachment materialization failure leaves original native rows uncancelled and exposes no private path', async () => {
  let fail = false;
  const f = fixture(async value => { if (fail) throw new Error('/private/image/read-failed'); return value.text; });
  const a = await f.queue.enqueue({ text: 'Original', images: [image] }); const before = f.queue.snapshot(); fail = true;
  await assert.rejects(f.queue.edit({ id: a.rowId, input: text('Edited'), revision: before.revision }), { message: 'Native queue preparation failed.' });
  assert.equal(f.cancellations, 0); assert.deepEqual(f.queue.snapshot(), before); assert.equal(f.submitted.length, 1);
});

test('ignored untrusted absolute paths cannot inject object-valued private data into public queue descriptors', async () => {
  const calls: ChatInput[] = [];
  const f = fixture(async value => { calls.push(value); return value.text; });
  const forged = { ...attachment, absolutePath: { bytes: 'inline attachment bytes' } };
  const queued = f.queue.enqueue({ text: 'File', files: [forged as unknown as typeof attachment] });
  forged.absolutePath.bytes = 'caller mutation';
  const result = await queued;
  assert.equal(result.snapshot.rows[0]!.input.files![0]!.absolutePath, '');
  assert.equal(calls[0]!.files![0]!.absolutePath, '');
  assert.equal(JSON.stringify(result).includes('caller mutation'), false);
});

const selectedSkill = { name: 'review', path: '/skills/review/SKILL.md' };
const selectedMention = { ...selectedSkill, start: 3, end: 10 };
test('queued selected skills are captured scalars; unchanged text keeps mentions and changed text only clears spans', async () => {
  const calls: ChatInput[] = [];
  const f = fixture(async value => { calls.push(structuredClone(value)); return { contents: value.text, metadata: { selection: structuredClone(value.skills) } }; });
  const caller = { text: '请用 $review', skills: [{ ...selectedSkill, secret: { value: 'private' } }], skillMentions: [{ ...selectedMention, secret: { value: 'private' } }] };
  const pending = f.queue.enqueue(caller);
  caller.skills[0]!.path = '/caller/mutation'; caller.skillMentions[0]!.start = 0;
  const queued = await pending;
  assert.deepEqual(calls[0]!.skills, [selectedSkill]);
  assert.deepEqual(calls[0]!.skillMentions, [selectedMention]);
  assert.equal(JSON.stringify(queued).includes('private'), false);
  const publicInput = queued.snapshot.rows[0]!.input;
  publicInput.skills![0]!.name = 'snapshot mutation'; publicInput.skillMentions![0]!.end = 0;
  const unchanged = await f.queue.edit({ id: queued.rowId, input: text('请用 $review'), revision: f.queue.snapshot().revision });
  assert.deepEqual(unchanged.snapshot.rows[0]!.input.skillMentions, [selectedMention]);
  assert.equal(calls.length, 1); assert.equal(f.cancellations, 0);
  const extended = await f.queue.edit({ id: queued.rowId, input: text('请用 $review carefully'), revision: f.queue.snapshot().revision });
  assert.deepEqual(extended.snapshot.rows[0]!.input.skills, [selectedSkill]);
  assert.deepEqual(extended.snapshot.rows[0]!.input.skillMentions, [], 'any changed text clears original spans, including a token still at its old offsets');
  const edited = await f.queue.edit({ id: queued.rowId, input: text('Review without a token'), revision: f.queue.snapshot().revision });
  assert.equal(edited.outcome, 'applied');
  assert.deepEqual(edited.snapshot.rows[0]!.input.skills, [selectedSkill]);
  assert.deepEqual(edited.snapshot.rows[0]!.input.skillMentions, []);
  assert.deepEqual(calls.at(-1)!.skills, [selectedSkill]);
  assert.deepEqual(calls.at(-1)!.skillMentions, []);
  const blanked = await f.queue.edit({ id: queued.rowId, input: text(''), revision: f.queue.snapshot().revision });
  assert.equal(blanked.outcome, 'applied'); assert.deepEqual(blanked.snapshot.rows[0]!.input.skills, [selectedSkill]);
  assert.equal(f.cancellations, 3);
});

test('skill preparation is required and errors leave existing native rows untouched', async () => {
  const missing = fixture();
  await assert.rejects(missing.queue.enqueue({ text: '$review', skills: [selectedSkill] }), { message: 'Native queue preparation failed.' });
  assert.equal(missing.submitted.length, 0);
  let fail = false;
  const f = fixture(async value => { if (fail) throw new Error('/private/skill/read-failed'); return value.text; });
  const queued = await f.queue.enqueue({ text: '$review', skills: [selectedSkill] });
  const before = f.queue.snapshot(); fail = true;
  await assert.rejects(f.queue.edit({ id: queued.rowId, input: text('Changed'), revision: before.revision }), { message: 'Native queue preparation failed.' });
  assert.deepEqual(f.queue.snapshot(), before); assert.equal(f.cancellations, 0); assert.equal(f.submitted.length, 1);
});

test('skill reorder and steer retain prepared native selection without resolving skills again', async () => {
  const prepared = { contents: '$review', metadata: { selectedSkill: { ...selectedSkill }, originalText: '$review', skillMentions: [{ ...selectedSkill, start: 0, end: 7 }] } };
  let reads = 0;
  const f = fixture(async value => { reads++; return value.skills?.length ? prepared : value.text; });
  const selected = await f.queue.enqueue({ text: '$review', skills: [selectedSkill], skillMentions: [{ ...selectedSkill, start: 0, end: 7 }] });
  const sibling = await f.queue.enqueue(text('Sibling'));
  const captured = structuredClone(f.submitted[0]!.text);
  prepared.metadata.selectedSkill.path = '/changed/catalog'; prepared.metadata.skillMentions[0]!.end = 1;
  const reordered = await f.queue.reorder({ ids: [sibling.rowId, selected.rowId], revision: f.queue.snapshot().revision });
  assert.equal(reordered.outcome, 'applied'); assert.equal(reads, 2);
  assert.deepEqual(f.submitted.at(-1)!.text, captured);
  assert.deepEqual(reordered.snapshot.rows[1]!.input.skills, [selectedSkill]);
  let finish!: () => void; f.steering = new Promise<void>(resolve => { finish = resolve; });
  const steered = await f.queue.steer({ id: selected.rowId, revision: f.queue.snapshot().revision });
  assert.equal(steered.outcome, 'applied'); assert.equal(reads, 2);
  assert.deepEqual(f.steered, [{ type: 'user', ...captured as object }]);
  finish(); await Promise.resolve(); await Promise.resolve();
});
