import { expect, type Page } from '@playwright/test';

export async function setNativeMenuPreference(page: Page, label: 'Show command outputs' | 'Show debug events', enabled: boolean) {
  const sidebar = page.getByRole('button', { name: 'Show sidebar', exact: true });
  const narrow = await sidebar.isVisible();
  if (narrow) await sidebar.click();
  await page.getByRole('button', { name: 'Account settings', exact: true }).click();
  const toggle = page.getByRole('menuitemcheckbox', { name: label, exact: true });
  if ((await toggle.getAttribute('aria-checked')) !== String(enabled)) await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', String(enabled));
  await page.keyboard.press('Escape');
  await expect(toggle).toBeHidden();
  if (narrow) await page.getByRole('button', { name: 'Show thread', exact: true }).click();
}

// Observe actual outgoing native RPCs without constructing a transport envelope.
export function observeNativeHistoryReads(page: Page) {
  let reads = 0;
  page.on('websocket', socket => {
    if (new URL(socket.url()).pathname !== '/rpc') return;
    socket.on('framesent', frame => { if (String(frame.payload).includes('/watchChat')) reads++; });
  });
  return () => reads;
}
