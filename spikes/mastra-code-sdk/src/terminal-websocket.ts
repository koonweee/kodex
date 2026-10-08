import { WebSocket, type RawData } from 'ws';

export interface TerminalSocketManager {
  attach(id: string, callbacks: { data: (data: Buffer) => void; exit: () => void }): { history: Buffer; detach: () => void };
  write(id: string, data: Buffer): void;
  resize(id: string, cols: number, rows: number): void;
}

/** Main's protocol stores the discriminator after the payload. Keep terminal
 * bytes off the oRPC socket and let the manager own the shell across views. */
export function connectTerminalSocket(socket: WebSocket, id: string, manager: TerminalSocketManager): void {
  let attachment: ReturnType<TerminalSocketManager['attach']> | undefined;
  let replaying = true, exitedDuringReplay = false, stopping = false, detached = false;
  const buffered: Buffer[] = [];
  const detach = () => {
    if (detached) return;
    detached = true;
    // A failed attachment has nothing to release. Detaching never kills a PTY.
    try { attachment?.detach(); } catch { /* Socket teardown is already final. */ }
  };
  socket.on('close', detach);
  socket.on('error', () => { if (socket.readyState === WebSocket.OPEN) socket.terminate(); });
  function send(data: Buffer | string) {
    if (socket.readyState !== WebSocket.OPEN || stopping) return;
    // Bound each view independently; a lagging reader can reconnect to the
    // manager's retained history without pausing or killing the shared PTY.
    if (Buffer.isBuffer(data) && socket.bufferedAmount + data.length > 8 * 1024 * 1024) {
      end('terminal output lagged; reconnect to replay history', 1013);
      return;
    }
    try { socket.send(data, { binary: Buffer.isBuffer(data) }, error => { if (error) socket.terminate(); }); }
    catch { socket.terminate(); }
  }
  function end(message: string, code: number) {
    if (stopping) return;
    send(message); stopping = true;
    if (socket.readyState === WebSocket.OPEN) {
      try { socket.close(code); } catch { socket.terminate(); }
    }
  }
  const exit = () => {
    if (replaying) exitedDuringReplay = true;
    else end('terminal exited', 1000);
  };
  try {
    attachment = manager.attach(id, {
      data: bytes => { if (replaying) buffered.push(Buffer.from(bytes)); else send(bytes); }, exit,
    });
    if (attachment.history.length) send(attachment.history);
    for (const bytes of buffered) send(bytes);
    buffered.length = 0; replaying = false;
    if (exitedDuringReplay) exit();
  } catch {
    replaying = false;
    end('terminal unavailable', 1011);
  }
  // Attach implementations are synchronous; a close emitted during attach still
  // releases the returned attachment, using the same close-owned teardown.
  if (detached) { detached = false; detach(); }
  socket.on('message', (data: RawData) => {
    if (stopping || socket.readyState !== WebSocket.OPEN) return;
    const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
    if (!bytes.length) { end('terminal protocol error: empty frame', 1002); return; }
    const payload = bytes.subarray(0, -1), variant = bytes[bytes.length - 1];
    if (variant === 0) {
      if (payload.length) end('terminal protocol error: begin frame must not include a payload', 1002);
    } else if (variant === 1) {
      try { manager.write(id, payload); } catch { end('terminal stdin closed', 1011); }
    } else if (variant === 255) {
      let size: unknown;
      try { size = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(payload)); } catch { /* Invalid JSON falls through to validation. */ }
      if (typeof size !== 'object' || size === null || Array.isArray(size) || !('cols' in size) || !('rows' in size)
        || !Number.isInteger(size.cols) || !Number.isInteger(size.rows)
        || typeof size.cols !== 'number' || typeof size.rows !== 'number'
        || size.cols < 1 || size.cols > 65535 || size.rows < 1 || size.rows > 65535) {
        end('terminal protocol error: invalid resize dimensions', 1002); return;
      }
      try { manager.resize(id, size.cols, size.rows); } catch { end('terminal resize failed', 1011); }
    } else end('terminal protocol error: unknown frame variant', 1002);
  });
}
