import { MantineProvider } from '@mantine/core';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { defaultDisplayState } from '../../../../spikes/mastra-code-sdk/node_modules/@mastra/core/dist/agent-controller/index.js';
import { TimelineItemRenderer } from '../timeline/renderers';
import type { ChatSnapshot } from './client';
import { timelinePresentation } from './presentation';

type Message = ChatSnapshot['messages'][number];
const reference = { name: 'review', path: '/native/skills/review/SKILL.md' };
const text = '请 $review inspect these files';
const mention = { ...reference, start: 2, end: 9 };
const expanded = `${text}\n\n<skill name="review">\nNATIVE_EXPANDED_SKILL_INSTRUCTIONS\n</skill>`;
const binding = { text, skills: [reference], mentions: [mention] };
function input(value: unknown = binding): Message {
  return { id: 'native-input', role: 'signal', createdAt: new Date(0), content: { format: 2, parts: [{ type: 'text', text: expanded }],
    metadata: { signal: { type: 'user', metadata: { clientId: 'correlation', kodexSkillInput: value } } } } };
}
function items(message: Message, display?: ChatSnapshot['display']) {
  return timelinePresentation({ messages: [message], display, revision: 1, history: { earliest: null, hasOlder: false } }).rows.flatMap(row => row.type === 'item' ? [row.item] : []);
}
afterEach(cleanup);
it('renders the owned original user text and shared skill chip once without displaying expanded model instructions', () => {
  const message = input(); message.content.parts.push({ type: 'text', text: 'Second native text part' });
  const mapped = items(message);
  expect(mapped).toHaveLength(2); expect(mapped[0]).toMatchObject({ text, clientId: 'correlation', skillMentions: [mention] });
  expect(mapped[1]).toMatchObject({ text: 'Second native text part', clientId: 'correlation' }); expect(mapped[1].skillMentions).toBeUndefined();
  render(<MantineProvider><TimelineItemRenderer item={mapped[0]} /></MantineProvider>);
  expect(screen.getByLabelText('$review skill')).toBeVisible(); expect(screen.getByText(/inspect these files/)).toBeVisible();
  expect(screen.queryByText(/NATIVE_EXPANDED_SKILL_INSTRUCTIONS/)).not.toBeInTheDocument();
});
it('preserves authoritative original text examples, files and images without stripping a user-owned envelope', () => {
  const file = { id: 'note', fileName: 'notes.txt', extension: 'txt', relativePath: '.kodex/uploads/chat/note/notes.txt', sizeBytes: 4, mimeType: 'text/plain' };
  const original = `${text}\n\n\`\`\`kodex-attachments\n- ${file.relativePath}\n\`\`\``;
  const message = input({ ...binding, text: original });
  message.content.metadata = { signal: { type: 'user', metadata: { kodexSkillInput: { ...binding, text: original }, kodexAttachments: [file] } } };
  message.content.parts.push({ type: 'file', data: 'PHN2Zy8+', mimeType: 'image/svg+xml' });
  expect(items(message)[0]).toMatchObject({ text: original, skillMentions: [mention], fileAttachments: [file], images: [{ url: 'data:image/svg+xml;base64,PHN2Zy8+' }] });
});
it('preserves raw model text for invalid references or spans and never hides assistant or notification content', () => {
  const invalid = [null, { ...binding, skills: [] }, { ...binding, skills: [{ ...reference, path: '' }] },
    { ...binding, mentions: [{ ...mention, path: '/unrelated/SKILL.md' }] }, { ...binding, mentions: [{ ...mention, start: -1 }] },
    { ...binding, mentions: [{ ...mention, end: text.length + 1 }] }, { ...binding, mentions: [{ ...mention, start: 2.5 }] },
    { ...binding, mentions: [{ ...mention, name: 'other' }] }, { ...binding, mentions: [mention, mention] }];
  for (const value of invalid) { const mapped = items(input(value)); expect(mapped[0].text).toBe(expanded); expect(mapped[0].skillMentions).toBeUndefined(); }
  const assistant = input(); assistant.role = 'assistant'; expect(items(assistant)[0].text).toBe(expanded); expect(items(assistant)[0].skillMentions).toBeUndefined();
  const notification = input(); notification.content.metadata = { signal: { type: 'notification', metadata: { kodexSkillInput: binding } } }; expect(items(notification)).toEqual([]);
});
it('supports cleared queue-edit bindings while retaining the native selected skill references', () => {
  const edited = items(input({ ...binding, text: 'Edited original input', mentions: [] }));
  expect(edited[0].text).toBe('Edited original input'); expect(edited[0].skillMentions).toEqual([]);
});
it('converges saved and live metadata and clears stale original text and chips on canonical replacement', () => {
  const message = input(), saved = items(message), display = defaultDisplayState(); display.currentMessage = structuredClone(message);
  expect(saved[0].skillMentions).toEqual([mention]); expect(items(message, display)).toEqual(saved);
  display.currentMessage = { ...message, content: { format: 2, parts: [{ type: 'text', text: 'New canonical text' }], metadata: { signal: { type: 'user' } } } };
  expect(items(message, display)[0].text).toBe('New canonical text'); expect(items(message, display)[0].skillMentions).toBeUndefined();
});
