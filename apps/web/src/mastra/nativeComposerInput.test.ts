import { expect, it } from 'vitest';
import { nativeComposerInput } from './nativeComposerInput';
it('retains explicit skill identities and selected spans with ordinary text', () => {
  expect(nativeComposerInput([{ type: 'text', text: 'Use $review' }, { type: 'skill', name: 'review', path: '/skills/review' }], [], [],
    [{ name: 'review', path: '/skills/review', start: 4, end: 11, displayName: 'Ignored display label' }])).toEqual({
    text: 'Use $review', skills: [{ name: 'review', path: '/skills/review' }], skillMentions: [{ name: 'review', path: '/skills/review', start: 4, end: 11 }],
  });
});
it('keeps plain input minimal and refuses unported input rather than silently dropping it', () => {
  expect(nativeComposerInput([{ type: 'text', text: 'hello' }], [], [], [])).toEqual({ text: 'hello' });
  expect(() => nativeComposerInput([{ type: 'image', url: 'https://example.invalid/image.png' }], [], [], [])).toThrow(/not connected/);
});
