/** Close admission/transport first, then supervised terminals and native stores.
 * A failed stage must not skip later cleanup before the entrypoint exits. */
export async function shutdownBackend(
  server: { close(): Promise<void> },
  terminals: { dispose(): Promise<void> },
  chats: { dispose(): Promise<void> },
) {
  const failures: string[] = [];
  const stages: Array<[string, () => Promise<void>]> = [
    ['transport', () => server.close()], ['terminals', () => terminals.dispose()], ['native runtime', () => chats.dispose()],
  ];
  for (const [name, close] of stages) {
    try { await close(); } catch { failures.push(name); }
  }
  if (failures.length) throw new Error(`Shutdown failed for ${failures.join(', ')}.`);
}
