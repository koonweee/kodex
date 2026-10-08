import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { ORPCError } from '@orpc/server';
import { spawn, type IPty } from 'node-pty';
import { defaultTerminalCommand, parseTerminalCommand } from './terminal-command.js';

export interface TerminalCreate { projectId?: string; cwd?: string; command?: string; title?: string }
export interface TerminalSessionInfo {
  id: string; title: string; cwd: string; command: string; createdAt: string;
  historySizeBytes: number; status: 'running' | 'exited';
}
interface Observer { data(chunk: Buffer): void; exit(): void }
interface Terminal {
  info: TerminalSessionInfo; pty: IPty; history: Buffer; observers: Set<Observer>;
  detachedAt: number; exited: Promise<void>; stopped: boolean;
}
interface Options {
  defaultCwd: string;
  projectCwd?: (projectId: string) => Promise<string>;
  now?: () => number;
}
const historyLimit = 1024 * 1024;
const detachedTtl = 5 * 60 * 1000;
const missing = () => new ORPCError('NOT_FOUND', { message: 'Terminal session was not found.' });

/** Host-owned interactive shells are independent of native chat/runtime lifetimes. */
export function createTerminalService(options: Options) {
  const terminals = new Map<string, Terminal>();
  const exiting = new Set<Promise<void>>();
  const now = options.now ?? Date.now;
  let closing: Promise<void> | undefined;
  const assertActive = () => {
    if (closing) throw new ORPCError('SERVICE_UNAVAILABLE', { message: 'Terminal service is shutting down.' });
  };
  function terminate(terminal: Terminal) {
    if (!terminal.stopped) {
      terminal.stopped = true;
      // Match portable-pty: let the shell hang up its jobs before forcing exit.
      terminal.pty.kill();
      const force = setTimeout(() => terminal.pty.kill('SIGKILL'), 200);
      void terminal.exited.then(() => clearTimeout(force));
    }
    return terminal.exited;
  }
  function cleanup() {
    for (const [id, terminal] of terminals) {
      if (terminal.info.status === 'exited' || (!terminal.observers.size && now() - terminal.detachedAt >= detachedTtl)) {
        terminals.delete(id);
        void terminate(terminal);
      }
    }
  }
  function get(id: string) {
    assertActive();
    const terminal = terminals.get(id);
    if (!terminal || terminal.stopped || terminal.info.status === 'exited') throw missing();
    return terminal;
  }
  const timer = setInterval(cleanup, 30_000);
  timer.unref();
  return {
    async create(input: TerminalCreate): Promise<TerminalSessionInfo> {
      assertActive();
      let requestedCwd = input.cwd ?? options.defaultCwd;
      if (input.projectId !== undefined) {
        if (!options.projectCwd) throw missing();
        requestedCwd = await options.projectCwd(input.projectId);
        if (input.cwd !== undefined && input.cwd !== requestedCwd) {
          throw new ORPCError('BAD_REQUEST', { message: 'Working directory must match the project root.' });
        }
      }
      let cwd: string;
      try {
        cwd = await realpath(resolve(options.defaultCwd, requestedCwd));
        if (!(await stat(cwd)).isDirectory()) throw new Error('Not a directory');
      } catch { throw new ORPCError('BAD_REQUEST', { message: 'Terminal working directory is unavailable.' }); }
      const command = input.command ?? defaultTerminalCommand();
      let argv: string[];
      try { argv = parseTerminalCommand(command); }
      catch { throw new ORPCError('BAD_REQUEST', { message: 'Terminal command has invalid quoting.' }); }
      if (!argv[0]) throw new ORPCError('BAD_REQUEST', { message: 'Terminal command cannot be empty.' });
      assertActive(); cleanup();
      if (terminals.size >= 8) throw new ORPCError('CONFLICT', { message: 'Terminal session limit reached; stop a terminal before opening another.' });
      const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !key.startsWith('CODEX_') && key !== 'OPENAI_API_KEY' && key !== 'OPENAI_BASE_URL')) as Record<string, string>;
      env.TERM = 'xterm-256color'; env.COLORTERM = 'truecolor';
      let pty: IPty;
      try { pty = spawn(argv[0], argv.slice(1), { cwd, env, cols: 80, rows: 24, name: 'xterm-256color', encoding: null }); }
      catch { throw new ORPCError('BAD_REQUEST', { message: 'Terminal command could not be started.' }); }
      let finish!: () => void;
      const exited = new Promise<void>(resolve => { finish = resolve; });
      const terminal: Terminal = {
        info: { id: randomUUID(), title: input.title?.trim() ? input.title : (basename(cwd) ? `${basename(cwd)}: ${command}` : command), cwd, command,
          createdAt: new Date().toISOString(), historySizeBytes: 0, status: 'running' },
        pty, history: Buffer.alloc(0), observers: new Set(), detachedAt: now(), exited, stopped: false,
      };
      exiting.add(exited);
      const data = pty.onData(chunk => {
        // node-pty's documented encoding:null mode returns Buffer despite its string typedef.
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        terminal.history = Buffer.concat([terminal.history, bytes]).subarray(-historyLimit);
        terminal.info.historySizeBytes = terminal.history.length;
        for (const observer of terminal.observers) observer.data(bytes);
      });
      const exit = pty.onExit(() => {
        terminal.info.status = 'exited'; terminal.stopped = true;
        for (const observer of terminal.observers) observer.exit();
        terminal.observers.clear(); data.dispose(); exit.dispose();
        exiting.delete(exited); finish();
      });
      terminals.set(terminal.info.id, terminal);
      return { ...terminal.info };
    },
    list() { assertActive(); cleanup(); return [...terminals.values()].map(terminal => ({ ...terminal.info })).sort((a, b) => a.createdAt.localeCompare(b.createdAt)); },
    attach(id: string, observer: Observer) {
      const terminal = get(id);
      terminal.observers.add(observer);
      let detached = false;
      return { history: Buffer.from(terminal.history), detach() {
        if (detached) return;
        detached = true; terminal.observers.delete(observer);
        if (!terminal.observers.size) terminal.detachedAt = now();
      } };
    },
    write(id: string, data: Buffer) { get(id).pty.write(data); },
    resize(id: string, cols: number, rows: number) {
      if (![cols, rows].every(value => Number.isInteger(value) && value > 0 && value <= 65535)) throw new ORPCError('BAD_REQUEST', { message: 'Invalid terminal size.' });
      get(id).pty.resize(cols, rows);
    },
    async delete(id: string) {
      const terminal = get(id); terminals.delete(id);
      await terminate(terminal);
      return { id };
    },
    dispose() {
      if (closing) return closing;
      clearInterval(timer);
      // Close admission before awaiting native child exit; no arbitrary shutdown sleep.
      closing = Promise.resolve().then(async () => {
        for (const terminal of terminals.values()) void terminate(terminal);
        terminals.clear(); await Promise.all(exiting);
      });
      return closing;
    },
  };
}
export type TerminalService = ReturnType<typeof createTerminalService>;
