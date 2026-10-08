import { useState } from 'react';
import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultDisplayState } from '../../../../spikes/mastra-code-sdk/node_modules/@mastra/core/dist/agent-controller/index.js';
import { ImageLightbox } from '../images/ImageLightbox';
import type { ImageLightboxImage } from '../images/types';
import { TimelineItemRenderer } from '../timeline/renderers';
import type { TimelineItem } from '../timeline/state';
import type { ChatSnapshot } from './client';
import { timelinePresentation } from './presentation';

type Message = ChatSnapshot['messages'][number];
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const gif = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const annotation = '<response_annotations>\n<annotation1>\nAssistant text: "Original evidence"\nUser annotation: "Check it"\n</annotation1>\n</response_annotations>';
// The native SDK persists filename at runtime although its FileUIPart type omits it.
function file(data: string, mimeType: string, filename?: string) { return { type: 'file' as const, data, mimeType, ...(filename && { filename }) }; }
function input(parts: Message['content']['parts']): Message {
  return { id: 'native-input', role: 'signal', createdAt: new Date(0), content: { format: 2, parts,
    metadata: { signal: { id: 'native-input', type: 'user', metadata: { clientId: 'input-correlation' } } } } };
}
function items(messages: Message[], display?: ChatSnapshot['display']): TimelineItem[] {
  return timelinePresentation({ messages, display, revision: 1, history: { earliest: null, hasOlder: false } }).rows.flatMap(row => row.type === 'item' ? [row.item] : []);
}
function Viewer({ item }: { item: TimelineItem }) {
  const [image, setImage] = useState<ImageLightboxImage | null>(null);
  return <MantineProvider><TimelineItemRenderer item={item} threadId="native-chat" onImageOpen={setImage} /><ImageLightbox image={image} onClose={() => setImage(null)} /></MantineProvider>;
}
afterEach(cleanup);
describe('native input image presentation', () => {
  it('attaches multiple native saved images once to the first user text row, preserving text, annotations and correlation', () => {
    const text = `Inspect <pixel> & keep text.\n\n${annotation}`;
    const mapped = items([input([file(png, 'image/png', 'pixel.png'),
      { type: 'text', text }, file(gif, 'image/gif', 'motion.gif'), { type: 'text', text: 'Second text part' }])]);
    expect(mapped).toHaveLength(2);
    expect(mapped[0]).toMatchObject({ id: 'native-input:1', kind: 'user_message', text, clientId: 'input-correlation', images: [
      { url: `data:image/png;base64,${png}`, path: 'pixel.png' }, { url: `data:image/gif;base64,${gif}`, path: 'motion.gif' },
    ] });
    expect(mapped[1]).toMatchObject({ text: 'Second text part', clientId: 'input-correlation' }); expect(mapped[1].images).toBeUndefined();
    render(<Viewer item={mapped[0]} />);
    expect(screen.getByText('Inspect <pixel> & keep text.')).toBeVisible(); expect(screen.getByText('Check it')).toBeVisible();
    const thumbnails = screen.getAllByRole('button', { name: /^Open / }); expect(thumbnails).toHaveLength(2); expect(thumbnails[0].querySelector('img')).toHaveAttribute('src', `data:image/png;base64,${png}`);
    fireEvent.click(screen.getByRole('button', { name: 'Open motion.gif' }));
    expect(screen.getByRole('dialog')).toBeVisible(); expect(screen.getByRole('button', { name: 'Close image preview' }).querySelector('img')).toHaveAttribute('src', `data:image/gif;base64,${gif}`);
    fireEvent.keyDown(document, { key: 'Escape' }); expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('creates one user row for image-only native input and uses the shared thumbnail viewer', () => {
    const message = input([file(png, 'image/png', 'pixel.png')]); message.role = 'user';
    const mapped = items([message]); expect(mapped).toHaveLength(1); expect(mapped[0]).toMatchObject({ kind: 'user_message', text: '', clientId: 'input-correlation', images: [{ url: `data:image/png;base64,${png}`, path: 'pixel.png' }] });
    render(<Viewer item={mapped[0]} />); fireEvent.click(screen.getByRole('button', { name: 'Open pixel.png' })); expect(screen.getByRole('dialog')).toBeVisible();
  });
  it('converges a live native input and dormant saved history to the same row without duplicate images', () => {
    const message = input([{ type: 'text', text: 'Inspect' }, file(png, 'image/png', 'pixel.png')]);
    const saved = items([structuredClone(message)]), display = defaultDisplayState(); display.currentMessage = message;
    expect(saved[0].images).toHaveLength(1);
    expect(items([], display)).toEqual(saved); expect(items([structuredClone(message)], display)).toEqual(saved);
    display.currentMessage = { ...message, content: { ...message.content, parts: [{ type: 'text', text: 'Canonical replacement' }] } };
    expect(items([message], display)[0].images).toBeUndefined();
  });
  it('accepts native image subtypes and unpadded bytes without turning paths, URLs or nonimage parts into previews', () => {
    const valid = input([file(' PHN2Zy8+ \n', 'image/svg+xml'), file('/9j/2Q', 'image/jpeg')]);
    expect(items([valid])[0].images).toEqual([{ url: 'data:image/svg+xml;base64,PHN2Zy8+' }, { url: 'data:image/jpeg;base64,/9j/2Q' }]);
    const invalid = input([{ type: 'text', text: 'Visible text' },
      file('/project/pixel.png', 'image/png'), file('https://example.test/pixel.png', 'image/png'),
      file(png, 'application/pdf', 'pixel.png'), file('not image bytes!', 'image/png'),
      file('', 'image/png')]);
    invalid.content.parts.push({ type: 'image', data: png, mimeType: 'image/png' } as unknown as Message['content']['parts'][number]);
    expect(items([invalid])).toHaveLength(1); expect(items([invalid])[0].images).toBeUndefined();
    const assistant = structuredClone(valid); assistant.role = 'assistant';
    const system = structuredClone(valid); system.role = 'system';
    const notification = structuredClone(valid); notification.content.metadata = { signal: { type: 'notification' } };
    expect(items([assistant, system, notification])).toEqual([]);
  });
});
