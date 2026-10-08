import { MantineProvider } from '@mantine/core';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { defaultDisplayState } from '../../../../spikes/mastra-code-sdk/node_modules/@mastra/core/dist/agent-controller/index.js';
import type { TimelineFileAttachment } from '../api/client';
import { TimelineItemRenderer } from '../timeline/renderers';
import type { ChatSnapshot } from './client';
import { timelinePresentation } from './presentation';

type Message = ChatSnapshot['messages'][number];
const files: TimelineFileAttachment[] = [
  { id: 'note', fileName: 'notes.md', extension: 'md', relativePath: '.kodex/uploads/chat/note/notes.md', sizeBytes: 5, mimeType: 'text/markdown' },
  { id: 'report', fileName: 'report.pdf', extension: 'pdf', relativePath: '.kodex/uploads/chat/report/report.pdf', sizeBytes: 8, mimeType: 'application/pdf' },
];
const envelope = (paths = files.map(file => file.relativePath)) => `\`\`\`kodex-attachments\n${paths.map(path => `- ${path}`).join('\n')}\n\`\`\``;
function input(parts: Message['content']['parts'], attachments: unknown = files): Message {
  return { id: 'native-input', role: 'signal', createdAt: new Date(0), content: { format: 2, parts,
    metadata: { signal: { type: 'user', metadata: { clientId: 'correlation', kodexAttachments: attachments } } } } };
}
function items(message: Message, display?: ChatSnapshot['display']) {
  return timelinePresentation({ messages: [message], display, revision: 1, history: { earliest: null, hasOlder: false } }).rows.flatMap(row => row.type === 'item' ? [row.item] : []);
}
afterEach(cleanup);
it('projects owned saved files once and strips only the matching attachment envelope while preserving text and correlation', () => {
  const prose = 'Review these files <carefully>.';
  const text = `${prose}\n\n<response_annotations>\n<annotation1>\nAssistant text: \"Original\"\nUser annotation: \"Check it\"\n</annotation1>\n</response_annotations>`;
  const mapped = items(input([{ type: 'text', text: `${text}\n\n${envelope()}` }, { type: 'text', text: 'Second text part' }]));
  expect(mapped).toHaveLength(2);
  expect(mapped[0]).toMatchObject({ kind: 'user_message', text, clientId: 'correlation', fileAttachments: files });
  expect(mapped[1]).toMatchObject({ text: 'Second text part', clientId: 'correlation' }); expect(mapped[1].fileAttachments).toBeUndefined();
  render(<MantineProvider><TimelineItemRenderer item={mapped[0]} /></MantineProvider>);
  expect(screen.getByText(prose)).toBeVisible(); expect(screen.getByText('Check it')).toBeVisible(); expect(screen.getByText('notes.md')).toBeVisible(); expect(screen.getByText('report.pdf')).toBeVisible();
  expect(screen.queryByText(/kodex-attachments/)).not.toBeInTheDocument();
});
it('renders file-only input and co-locates image and file attachments on one user row', () => {
  const fileOnly = items(input([{ type: 'text', text: envelope() }]));
  expect(fileOnly).toHaveLength(1); expect(fileOnly[0]).toMatchObject({ kind: 'user_message', text: '', fileAttachments: files });
  render(<MantineProvider><TimelineItemRenderer item={fileOnly[0]} /></MantineProvider>); expect(screen.getByText('notes.md')).toBeVisible(); cleanup();
  // The actual native saved file has filename although FileUIPart omits it.
  const imagePart = { type: 'file' as const, data: 'PHN2Zy8+', mimeType: 'image/svg+xml', filename: 'picture.svg' };
  const mixed = items(input([imagePart]));
  expect(mixed).toHaveLength(1); expect(mixed[0]).toMatchObject({ kind: 'user_message', text: '', fileAttachments: files, images: [{ path: 'picture.svg', url: 'data:image/svg+xml;base64,PHN2Zy8+' }], clientId: 'correlation' });
  render(<MantineProvider><TimelineItemRenderer item={mixed[0]} onImageOpen={vi.fn()} /></MantineProvider>); expect(screen.getByText('notes.md')).toBeVisible(); expect(screen.getByRole('button', { name: 'Open picture.svg' })).toBeVisible();
  const noText = items(input([])); expect(noText).toHaveLength(1); expect(noText[0].fileAttachments).toEqual(files);
});
it('preserves arbitrary or mismatched user envelopes and ignores malformed, assistant and notification metadata', () => {
  const text = `User-authored example\n\n${envelope()}`;
  const unowned = input([{ type: 'text', text }]); unowned.content.metadata = undefined; unowned.role = 'user';
  expect(items(unowned)[0]).toMatchObject({ text }); expect(items(unowned)[0].fileAttachments).toBeUndefined();
  const mismatched = `Keep this\n\n${envelope(['.kodex/uploads/chat/other/other.md'])}`;
  expect(items(input([{ type: 'text', text: mismatched }]))[0].text).toBe(mismatched);
  const poisoned = [null, { ...files[0], sizeBytes: '5' }, { ...files[0], relativePath: '../outside.md' }, { ...files[0], relativePath: '.kodex/uploads/chat/../outside.md' }, { ...files[0], fileName: 'bad\nname.md' }];
  for (const attachment of poisoned) { const mapped = items(input([{ type: 'text', text }], [attachment])); expect(mapped[0].text).toBe(text); expect(mapped[0].fileAttachments).toBeUndefined(); }
  const assistant = input([{ type: 'text', text }]); assistant.role = 'assistant'; expect(items(assistant)[0].fileAttachments).toBeUndefined(); expect(items(assistant)[0].text).toBe(text);
  const notification = input([{ type: 'text', text }]); notification.content.metadata = { signal: { type: 'notification', metadata: { kodexAttachments: files } } }; expect(items(notification)).toEqual([]);
});
it('converges live and dormant saved file input and clears stale attachments on canonical replacement', () => {
  const message = input([{ type: 'text', text: `Read\n\n${envelope()}` }]);
  const saved = items(message), display = defaultDisplayState(); display.currentMessage = structuredClone(message);
  expect(saved[0].fileAttachments).toEqual(files);
  expect(items(message, display)).toEqual(saved);
  display.currentMessage = { ...message, content: { format: 2, parts: [{ type: 'text', text: 'Replacement without attachments' }], metadata: { signal: { type: 'user', metadata: { clientId: 'correlation' } } } } };
  const replacement = items(message, display); expect(replacement).toHaveLength(1); expect(replacement[0].text).toBe('Replacement without attachments'); expect(replacement[0].fileAttachments).toBeUndefined();
});
it('normalizes saved file metadata to the shared descriptor without retaining supplied absolute paths or extra payload', () => {
  const mapped = items(input([{ type: 'text', text: envelope() }], files.map(file => ({ ...file, absolutePath: '/untrusted/path', privatePayload: 'private bytes' }))));
  expect(mapped[0].fileAttachments).toEqual(files);
  expect(JSON.stringify(mapped[0].fileAttachments)).not.toContain('untrusted'); expect(JSON.stringify(mapped[0].fileAttachments)).not.toContain('private bytes');
});
