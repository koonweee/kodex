import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, extname, join } from 'node:path';
import sirv from 'sirv';

const excluded = [/^\/(?:rpc|v1|terminals)(?:\/|$)/, /\/\./];
function cacheControl(path: string) {
  const extension = extname(path);
  return path.startsWith('/assets/') && !['.html', '.htm'].includes(extension)
    && /-[A-Za-z0-9_]{8,}\.[^./]+$/.test(basename(path))
    ? 'public, max-age=31536000, immutable' : 'no-cache';
}

/** Serve trusted built assets through native HTTP middleware. Validate before
 * binding the backend, so a configured missing build cannot silently be ignored. */
export async function createFrontendHttp(frontendDir: string) {
  let root: string;
  try {
    if (!frontendDir.trim()) throw new Error('Empty directory');
    root = await realpath(frontendDir);
    if (!(await stat(root)).isDirectory() || !(await stat(join(root, 'index.html'))).isFile()) throw new Error('Missing built index');
    await access(root, constants.R_OK | constants.X_OK);
    await access(join(root, 'index.html'), constants.R_OK);
  } catch { throw new Error('Frontend directory must contain a readable built index.html.'); }
  const assets = sirv(root, {
    // Native fresh reads preserve frontend-only replacement and worker updates.
    dev: true, single: true, etag: true, dotfiles: false,
    // Sirv already excludes missing file extensions from SPA fallback. Keep API
    // namespaces and dot segments outside that fallback as well.
    ignores: excluded,
    setHeaders(response, path) { response.setHeader('cache-control', cacheControl(path)); },
  });
  return function handleFrontend(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    if (request.method !== 'GET' && request.method !== 'HEAD') return Promise.resolve(false);
    let path: string;
    try { path = decodeURIComponent(request.url?.split('?')[0] ?? '/'); }
    catch { return Promise.resolve(false); }
    if (excluded.some(pattern => pattern.test(path))) return Promise.resolve(false);
    return new Promise<boolean>((resolve, reject) => {
      const done = (matched: boolean) => {
        response.off('finish', finished); response.off('close', finished);
        resolve(matched);
      };
      const finished = () => done(true);
      response.once('finish', finished); response.once('close', finished);
      try { assets(request, response, () => done(false)); }
      catch (error) {
        response.off('finish', finished); response.off('close', finished); reject(error);
      }
    });
  };
}
