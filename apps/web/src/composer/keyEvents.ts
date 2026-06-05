const CURSOR_SYNC_KEY_UP_KEYS = new Set([
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "End",
  "Home",
  "PageDown",
  "PageUp",
]);

export function shouldSyncComposerCursorOnKeyUp(key: string) {
  return CURSOR_SYNC_KEY_UP_KEYS.has(key);
}
