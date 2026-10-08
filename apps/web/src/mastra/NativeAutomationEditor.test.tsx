import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { AutomationsPane } from '../automations/AutomationsPane';
import { AutomationEditorModal } from '../automations/AutomationEditorModal';
import type { NativeAutomation } from './nativeAutomationTypes';

const saved: NativeAutomation = { id: 'native-automation', name: 'Calendar review', prompt: 'Review workspace', targetThreadId: 'native-chat',
  cron: '15 14 * * 2', timezone: 'America/New_York', status: 'active', nextFireAt: Date.UTC(2026, 10, 3, 14, 15), createdAt: 1, updatedAt: 2 };
const options = [{ value: 'native-chat', label: 'Native chat' }, { value: 'other-chat', label: 'Other chat' }];
const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
beforeAll(() => Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() }));
afterAll(() => { if (originalScroll) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScroll); else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView'); });
function wrap(node: React.ReactNode) { return <QueryClientProvider client={new QueryClient()}><MantineProvider env="test">{node}</MantineProvider></QueryClientProvider>; }
function editorProps() {
  return { mode: 'calendar' as const, automation: saved, fallbackThreadId: null, opened: true, threadOptions: options,
    targetReadOnly: false, onClose: vi.fn(), onCreate: vi.fn().mockResolvedValue(saved), onUpdate: vi.fn().mockResolvedValue(saved),
    onDelete: vi.fn(), onPause: vi.fn(), onResume: vi.fn(), renderRuns: (id: string) => <div>Native history {id}</div> };
}

it('reuses the shared table/editor with truthful calendar columns and native history', async () => {
  render(wrap(<AutomationsPane mode="calendar" automations={[saved]} defaultThreadId="native-chat" isLoading={false} threadOptions={options}
    targetReadOnly={false} onCreateAutomation={vi.fn()} onUpdateAutomation={vi.fn()} onDeleteAutomation={vi.fn()}
    onPauseAutomation={vi.fn()} onResumeAutomation={vi.fn()} onShowMobileSidebar={vi.fn()} renderRuns={id => <div>Native history {id}</div>} />));
  expect(screen.queryByRole('button', { name: 'Failures' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Schedule' })).toBeInTheDocument();
  expect(screen.getAllByText('15 14 * * 2 (America/New_York)').length).toBeGreaterThan(0);
  await userEvent.click(screen.getByRole('row', { name: /Calendar review/ }));
  expect(await screen.findByRole('dialog', { name: 'Automation details' })).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Cron expression' })).toHaveValue(saved.cron);
  expect(screen.getByText('Native history native-automation')).toBeInTheDocument();
  expect(screen.queryByLabelText('Start')).not.toBeInTheDocument();
});

it('sends native calendar values and an explicitly edited target without interval fields or silent omission', async () => {
  const props = editorProps();
  render(wrap(<AutomationEditorModal {...props} />));
  const user = userEvent.setup();
  await user.click(screen.getByRole('textbox', { name: 'Target thread' }));
  await user.click(await screen.findByRole('option', { name: 'Other chat' }));
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(props.onUpdate).toHaveBeenCalledWith(saved.id, {
    name: saved.name, prompt: saved.prompt, targetThreadId: 'other-chat', cron: saved.cron, timezone: saved.timezone,
  }, saved));
  expect(props.onClose).toHaveBeenCalledOnce();
});

it('locks the existing target only when requested and retains rejected drafts for explicit retry', async () => {
  const props = { ...editorProps(), targetReadOnly: true };
  props.onUpdate.mockRejectedValueOnce(new Error('Native cron rejected'));
  render(wrap(<AutomationEditorModal {...props} />));
  expect(screen.getByRole('textbox', { name: 'Target thread' })).toBeDisabled();
  const user = userEvent.setup();
  const cron = screen.getByRole('textbox', { name: 'Cron expression' });
  await user.clear(cron); await user.type(cron, 'invalid cron');
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByText('Native cron rejected')).toBeInTheDocument();
  expect(cron).toHaveValue('invalid cron');
  expect(props.onClose).not.toHaveBeenCalled();
});

it('creates against a selectable target even when existing targets are locked, and leaves completed transitions unavailable', async () => {
  const props = { ...editorProps(), automation: null, fallbackThreadId: 'native-chat', targetReadOnly: true };
  const view = render(wrap(<AutomationEditorModal {...props} />));
  expect(screen.getByRole('textbox', { name: 'Target thread' })).not.toBeDisabled();
  await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'New calendar');
  await userEvent.type(screen.getByLabelText('Automation prompt'), 'Inspect project');
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(props.onCreate).toHaveBeenCalledWith(expect.objectContaining({ name: 'New calendar', prompt: 'Inspect project', targetThreadId: 'native-chat', cron: '0 9 * * *' })));
  view.rerender(wrap(<AutomationEditorModal {...editorProps()} automation={{ ...saved, status: 'completed' }} />));
  expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
});

it('keeps the opened draft and original baseline when a native refill changes metadata or peer fields', async () => {
  const props = editorProps();
  const view = render(wrap(<AutomationEditorModal {...props} />));
  const name = screen.getByRole('textbox', { name: 'Name' });
  await userEvent.clear(name); await userEvent.type(name, 'Local draft name');
  view.rerender(wrap(<AutomationEditorModal {...props} fallbackThreadId="other-chat" automation={{ ...saved, prompt: 'Peer prompt', timezone: 'UTC', status: 'paused', updatedAt: 3 }} />));
  expect(name).toHaveValue('Local draft name');
  expect(screen.getByLabelText('Automation prompt')).toHaveValue(saved.prompt);
  expect(screen.getByRole('textbox', { name: 'Timezone' })).toHaveValue(saved.timezone);
  expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(props.onUpdate).toHaveBeenCalledWith(saved.id, {
    name: 'Local draft name', prompt: saved.prompt, targetThreadId: saved.targetThreadId, cron: saved.cron, timezone: saved.timezone,
  }, saved));
});
