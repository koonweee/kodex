import { MantineProvider } from '@mantine/core';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import type { NativeAutomation } from '../mastra/nativeAutomationTypes';
import { AutomationsPane } from './AutomationsPane';
import type { AutomationThreadOption } from './threadOptions';

it('refreshes late target labels and their active sort when the same automation rows remain', async () => {
  const base: NativeAutomation = { id: 'first', name: 'First automation', prompt: 'Inspect', targetThreadId: 'first-chat',
    cron: '0 9 * * *', timezone: 'UTC', status: 'active', nextFireAt: 3, createdAt: 1, updatedAt: 2 };
  const rows = [base, { ...base, id: 'second', name: 'Second automation', targetThreadId: 'second-chat' }];
  const pane = (threadOptions: AutomationThreadOption[]) => <MantineProvider env="test"><AutomationsPane
    mode="calendar" automations={rows} threadOptions={threadOptions} defaultThreadId={null} isLoading={false}
    targetReadOnly={false} renderRuns={() => null} onCreateAutomation={vi.fn()} onUpdateAutomation={vi.fn()}
    onDeleteAutomation={vi.fn()} onPauseAutomation={vi.fn()} onResumeAutomation={vi.fn()} onShowMobileSidebar={vi.fn()}
  /></MantineProvider>;
  const view = render(pane([]));
  expect(within(screen.getByRole('row', { name: /First automation/ })).getByRole('cell', { name: 'Unknown thread' })).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Target thread' }));
  view.rerender(pane([{ value: 'first-chat', label: 'Zulu chat' }, { value: 'second-chat', label: 'Alpha chat' }]));
  expect(within(screen.getByRole('row', { name: /First automation/ })).getByRole('cell', { name: 'Zulu chat' })).toBeInTheDocument();
  expect(screen.queryByText('Unknown thread')).not.toBeInTheDocument();
  expect(screen.getAllByRole('row').slice(1).map(row => within(row).getAllByRole('cell')[0].textContent)).toEqual([
    expect.stringContaining('Second automation'), expect.stringContaining('First automation'),
  ]);
  view.rerender(pane([{ value: 'first-chat', label: 'Alpha chat' }, { value: 'second-chat', label: 'Zulu chat' }]));
  expect(within(screen.getByRole('row', { name: /First automation/ })).getByRole('cell', { name: 'Alpha chat' })).toBeInTheDocument();
  expect(screen.getAllByRole('row').slice(1).map(row => within(row).getAllByRole('cell')[0].textContent)).toEqual([
    expect.stringContaining('First automation'), expect.stringContaining('Second automation'),
  ]);
});
