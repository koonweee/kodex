import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { NativeAutomationScheduleFields } from './NativeAutomationScheduleFields';
import { nativeAutomationScheduleDraft, type NativeAutomationScheduleDraft } from './nativeAutomationForm';

const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
beforeAll(() => Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() }));
afterAll(() => {
  if (originalScrollIntoView) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView);
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
});

function Harness({ initial }: { initial: NativeAutomationScheduleDraft }) {
  const [value, onChange] = useState(initial);
  return <MantineProvider env="test"><NativeAutomationScheduleFields value={value} onChange={onChange} /><output>{value.cron}|{value.timezone}|{value.preset}</output></MantineProvider>;
}

it('shows persisted custom cron and timezone instead of replacing them with browser defaults', () => {
  render(<Harness initial={nativeAutomationScheduleDraft({ cron: '15 14 * * 2', timezone: 'America/New_York' })} />);
  expect(screen.getByRole('textbox', { name: 'Cron expression' })).toHaveValue('15 14 * * 2');
  expect(screen.getByRole('textbox', { name: 'Timezone' })).toHaveValue('America/New_York');
  expect(screen.getByRole('textbox', { name: 'Schedule' })).toHaveValue('Custom cron');
});

it('switches presets, preserves the current cron when choosing Custom and edits the timezone', async () => {
  const user = userEvent.setup();
  render(<Harness initial={nativeAutomationScheduleDraft(null, 'Asia/Singapore')} />);
  await user.click(screen.getByRole('textbox', { name: 'Schedule' }));
  await user.click(await screen.findByRole('option', { name: 'Every hour' }));
  expect(screen.getByRole('status')).toHaveTextContent('0 * * * *|Asia/Singapore|hourly');
  await user.click(screen.getByRole('textbox', { name: 'Schedule' }));
  await user.click(await screen.findByRole('option', { name: 'Custom cron' }));
  const cron = screen.getByRole('textbox', { name: 'Cron expression' });
  expect(cron).toHaveValue('0 * * * *');
  await user.clear(cron);
  await user.type(cron, '30 8 * * 1-5');
  const timezone = screen.getByRole('textbox', { name: 'Timezone' });
  await user.clear(timezone);
  await user.type(timezone, 'Europe/London');
  expect(screen.getByRole('status')).toHaveTextContent('30 8 * * 1-5|Europe/London|custom');
});
