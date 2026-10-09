import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { getComposerSettings, listPermissionProfiles, persistComposerSettings } from '../api/client';
import { PreferencesModal, type PreferenceSection } from '../PreferencesModal';
import { NativeExecutionPreferencesPanel } from './NativeExecutionPreferencesPanel';

vi.mock('../api/client', async original => ({ ...await original<typeof import('../api/client')>(),
  getComposerSettings: vi.fn(), listPermissionProfiles: vi.fn(), persistComposerSettings: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());
function preferences(native: boolean, initialSection: PreferenceSection = 'execution') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Harness() {
    const [section, setSection] = useState<PreferenceSection>(initialSection);
    return <PreferencesModal opened activeSection={section} onSectionChange={setSection} onClose={vi.fn()}
      preferences={{ mode: 'dark', lightThemeId: 'paper-light', darkThemeId: 'oled-black' }} resolvedSchemeId="oled-black"
      onModeChange={vi.fn()} onThemeChange={vi.fn()} {...(native ? { executionPanel: <NativeExecutionPreferencesPanel /> } : {})} />;
  }
  return render(<QueryClientProvider client={client}><MantineProvider env="test"><Harness /></MantineProvider></QueryClientProvider>);
}

it('shows the native execution policy without legacy requests or misleading selectable approval modes', async () => {
  preferences(true);
  expect(screen.getByText('Runs on the gateway machine without a sandbox.')).toBeInTheDocument();
  expect(screen.getByText('Ordinary tools run without per-action approval.')).toBeInTheDocument();
  expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
  expect(screen.queryByRole('radio', { name: 'Auto review' })).not.toBeInTheDocument();
  expect(getComposerSettings).not.toHaveBeenCalled(); expect(listPermissionProfiles).not.toHaveBeenCalled();
  expect(persistComposerSettings).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Interface' }));
  expect(screen.queryByText('Ordinary tools run without per-action approval.')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Execution' }));
  expect(screen.getByText('Ordinary tools run without per-action approval.')).toBeInTheDocument();
  expect(getComposerSettings).not.toHaveBeenCalled(); expect(listPermissionProfiles).not.toHaveBeenCalled();
});

it('retains default main execution queries and permission controls when no replacement is supplied', async () => {
  vi.mocked(getComposerSettings).mockResolvedValue({ permissionProfileId: null, approvalPolicy: 'on-request', approvalsReviewer: 'user', writeTarget: { filePath: '/native/config.toml', version: 'v1' } });
  vi.mocked(listPermissionProfiles).mockResolvedValue([]);
  preferences(false, 'appearance');
  expect(getComposerSettings).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Execution' }));
  await waitFor(() => expect(screen.getByRole('radio', { name: 'Ask me' })).toBeChecked());
  expect(screen.getByRole('radio', { name: /^Default/ })).toBeEnabled();
  expect(screen.getByRole('radio', { name: 'Auto review' })).toBeEnabled();
  expect(getComposerSettings).toHaveBeenCalledOnce(); expect(listPermissionProfiles).toHaveBeenCalledOnce();
});
