import os from 'node:os';
import { split } from 'shlex';

/** Literal argument splitting only: this never invokes a shell or expands the environment. */
export function parseTerminalCommand(command: string): string[] {
  try {
    if (typeof command !== 'string' || command.includes('\0')) throw new Error();
    const arguments_ = split(command);
    if (!arguments_.length || !arguments_[0]!.trim()) throw new Error();
    return arguments_;
  } catch {
    throw new Error('Invalid terminal command.');
  }
}

export function defaultTerminalCommand(): string {
  if (os.platform() === 'win32') return process.env.COMSPEC?.trim() || 'cmd.exe';
  const configured = process.env.SHELL?.trim();
  if (configured) return configured;
  try { return os.userInfo().shell?.trim() || '/bin/sh'; }
  catch { return '/bin/sh'; }
}
