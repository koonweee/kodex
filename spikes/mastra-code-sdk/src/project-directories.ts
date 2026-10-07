import { readdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { ORPCError } from '@orpc/server';

function within(home: string, path: string) {
  const difference = relative(home, path);
  return difference !== '..' && !difference.startsWith(`..${sep}`) && !isAbsolute(difference);
}
function directoryError(error: unknown): never {
  if (error instanceof ORPCError) throw error;
  throw new ORPCError((error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'NOT_FOUND' : 'BAD_REQUEST', {
    message: (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'Directory does not exist.' : 'Directory cannot be read.',
  });
}

/** Same chooser boundary as main: browse the real gateway home, not the SDK config home. */
export async function listProjectDirectories(options: { home: string; path?: string }) {
  try {
    const homePath = await realpath(options.home);
    const requested = options.path ?? homePath;
    if (!isAbsolute(requested)) throw new ORPCError('BAD_REQUEST', { message: 'Directory path must be absolute.' });
    const path = await realpath(requested);
    if (!within(homePath, path)) throw new ORPCError('BAD_REQUEST', { message: 'Directory must be inside your home.' });
    if (!(await stat(path)).isDirectory()) throw new ORPCError('BAD_REQUEST', { message: 'Path is not a directory.' });
    const directories: Array<{ name: string; path: string }> = [];
    for (const name of await readdir(path)) {
      try {
        const child = await realpath(join(path, name));
        if (within(homePath, child) && (await stat(child)).isDirectory()) directories.push({ name, path: child });
      } catch { /* Deleted, unreadable and dangling children are absent from the chooser. */ }
    }
    const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
    directories.sort((left, right) => compare(left.name.toLowerCase(), right.name.toLowerCase()) || compare(left.name, right.name));
    const parent = dirname(path);
    return { path, homePath, parentPath: parent !== path && within(homePath, parent) ? parent : null, directories };
  } catch (error) { return directoryError(error); }
}
