import { beforeEach, expect, it, vi } from 'vitest';
import type { TerminalSessionInfo } from '../api/client';
import { mastraClient } from './client';
import { nativeTerminalApi } from './nativeTerminalApi';

vi.mock('./client', () => ({ mastraClient: { listTerminals: vi.fn(), createTerminal: vi.fn(), deleteTerminal: vi.fn() } }));
const session: TerminalSessionInfo = {
  id: 'native-terminal', title: 'Shell', cwd: '/project', command: '/bin/zsh',
  createdAt: '2026-10-08T00:00:00Z', historySizeBytes: 12, status: 'running',
};
beforeEach(() => vi.resetAllMocks());

it('uses the typed native inventory, creation and deletion calls with shared terminal results', async () => {
  vi.mocked(mastraClient.listTerminals).mockResolvedValue([session]);
  vi.mocked(mastraClient.createTerminal).mockResolvedValue(session);
  vi.mocked(mastraClient.deleteTerminal).mockResolvedValue({ id: session.id });
  expect(await nativeTerminalApi.list()).toEqual([session]);
  expect(await nativeTerminalApi.create({ projectId: 'project-1', command: '/bin/zsh', title: 'Shell' })).toEqual(session);
  expect(mastraClient.createTerminal).toHaveBeenCalledWith({ projectId: 'project-1', command: '/bin/zsh', title: 'Shell' });
  expect(await nativeTerminalApi.delete(session.id)).toEqual({ id: session.id });
  expect(mastraClient.deleteTerminal).toHaveBeenCalledWith({ terminalId: session.id });
});

it('omits absent shared optional fields while preserving explicit native working directories', async () => {
  vi.mocked(mastraClient.createTerminal).mockResolvedValue(session);
  await nativeTerminalApi.create({ cwd: '/explicit', command: null, projectId: null, title: undefined });
  expect(mastraClient.createTerminal).toHaveBeenCalledWith({ cwd: '/explicit' });
  await nativeTerminalApi.create();
  expect(mastraClient.createTerminal).toHaveBeenLastCalledWith({});
});
