import assert from 'node:assert/strict';
import os from 'node:os';
import { test } from 'node:test';
import { defaultTerminalCommand, parseTerminalCommand } from '../src/terminal-command.js';

test('terminal commands are literal argv with quotes and escapes, never shell expansion', () => {
  assert.deepEqual(parseTerminalCommand('/bin/sh -l'), ['/bin/sh', '-l']);
  assert.deepEqual(parseTerminalCommand("\"/path with spaces/shell\" --title \"two words\" '' café\\ value"), ['/path with spaces/shell', '--title', 'two words', '', 'café value']);
  assert.deepEqual(parseTerminalCommand('echo $HOME ${HOME} $(whoami) | cat && x > y a#b'), ['echo', '$HOME', '${HOME}', '$(whoami)', '|', 'cat', '&&', 'x', '>', 'y', 'a#b']);
});

test('empty commands, NUL bytes and incomplete native quoting reject before PTY spawn', () => {
  for (const command of ['', ' \t\n', "''", '"" arg', 'echo "unterminated', 'echo trailing\\', 'echo \0private']) {
    assert.throws(() => parseTerminalCommand(command), /Invalid terminal command/);
  }
});

test('Unix default uses nonblank SHELL, then account shell, then sh fallback', t => {
  t.mock.method(os, 'platform', () => 'darwin');
  const previous = process.env.SHELL;
  t.after(() => { if (previous === undefined) delete process.env.SHELL; else process.env.SHELL = previous; });
  const info = os.userInfo();
  t.mock.method(os, 'userInfo', () => ({ ...info, shell: '/bin/account-shell' }));
  process.env.SHELL = '  /bin/preferred-shell -l  ';
  assert.equal(defaultTerminalCommand(), '/bin/preferred-shell -l');
  process.env.SHELL = '  ';
  assert.equal(defaultTerminalCommand(), '/bin/account-shell');
  delete process.env.SHELL;
  assert.equal(defaultTerminalCommand(), '/bin/account-shell');
  t.mock.method(os, 'userInfo', () => ({ ...info, shell: null }));
  assert.equal(defaultTerminalCommand(), '/bin/sh');
  t.mock.method(os, 'userInfo', () => { throw new Error('Account lookup unavailable'); });
  assert.equal(defaultTerminalCommand(), '/bin/sh');
});

test('Windows default uses nonblank COMSPEC or cmd without consulting Unix SHELL', t => {
  t.mock.method(os, 'platform', () => 'win32');
  const previous = process.env.COMSPEC;
  t.after(() => { if (previous === undefined) delete process.env.COMSPEC; else process.env.COMSPEC = previous; });
  process.env.COMSPEC = ' C:\\Windows\\System32\\cmd.exe ';
  assert.equal(defaultTerminalCommand(), 'C:\\Windows\\System32\\cmd.exe');
  process.env.COMSPEC = '  ';
  assert.equal(defaultTerminalCommand(), 'cmd.exe');
});
