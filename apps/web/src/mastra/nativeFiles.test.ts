import { describe, expect, it } from 'vitest';
import { nativeFileFields } from './nativeFiles';
import { createElement } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { TimelineActivityGroupRenderer } from '../timeline/renderers';
import type { TimelineItem } from '../timeline/state';

describe('native file operations', () => {
  it.each([
    ['view', 'Read'], ['write_file', 'Write'], ['string_replace_lsp', 'Replace'],
    ['ast_smart_edit', 'Edit'], ['delete_file', 'Delete'],
  ])('describes the requested %s operation without claiming a change', (name, action) => {
    expect(nativeFileFields(name, { path: 'src/example.ts' })).toEqual({
      kind: 'file_change', path: 'src/example.ts', action, fileChangeOutcomeKnown: false,
    });
  });
  it.each([undefined, null, {}, { path: 5 }, { path: '' }])('leaves missing or invalid paths generic: %j', args => {
    expect(nativeFileFields('write_file', args)).toBeNull();
  });
  it('does not reinterpret custom tools as native file operations', () => {
    expect(nativeFileFields('read_file', { path: 'README.md' })).toBeNull();
  });
  it('keeps requested file operations separate from known changes in collapsed and expanded activity', () => {
    const operation: TimelineItem = { id: 'request', turnId: null, displayOrder: 0, debugEvents: [], payload: {}, status: 'completed', text: '', kind: 'file_change', ...nativeFileFields('string_replace_lsp', { path: 'example.ts' }), output: 'String not found\nFull native diagnostic' };
    const rendered = render(createElement(MantineProvider, null, createElement(TimelineActivityGroupRenderer, { items: [operation] })));
    expect(screen.getByText('Requested 1 file operation')).toBeInTheDocument();
    expect(screen.getByText('Replace example.ts')).toBeInTheDocument();
    const details = rendered.container.querySelector('details.kodex-activity-item')!;
    (details as HTMLDetailsElement).open = true;
    fireEvent(details, new Event('toggle'));
    expect(screen.getByText(/String not found/)).toHaveTextContent('Full native diagnostic');
    expect(screen.queryByText(/Modified|changed|Success/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/File diff/)).not.toBeInTheDocument();
    rendered.rerender(createElement(MantineProvider, null, createElement(TimelineActivityGroupRenderer, { items: [operation, { ...operation, id: 'known', fileChangeOutcomeKnown: undefined, action: 'Added', path: 'created.ts', output: undefined }] })));
    expect(screen.getByText('Changed 1 file, requested 1 file operation')).toBeInTheDocument();
    expect(screen.getByText('Added created.ts')).toBeInTheDocument();
  });
});
