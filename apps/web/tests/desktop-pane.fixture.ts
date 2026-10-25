import { expect, type Page } from "@playwright/test";

export async function sidebar(page: Page) {
  const nav = page.getByRole("navigation", { name: "Workspace", exact: true });
  if (!await nav.isVisible()) await page.getByRole("button", { name: /^(Show sidebar|Projects)$/i }).click();
  await expect(nav).toBeVisible();
  return nav;
}
export async function openDesktop(page: Page) {
  await (await sidebar(page)).getByRole("button", { name: "Desktop", exact: true }).click();
  await expect(page.getByTitle("Mac desktop viewer", { exact: true })).toBeVisible();
  const frame = page.frameLocator('iframe[title="Mac desktop viewer"]');
  await expect(frame.locator("#screen canvas")).toBeVisible();
  return frame;
}
