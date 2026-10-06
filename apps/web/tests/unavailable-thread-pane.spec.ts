import { expect, test } from "@playwright/test";

import { nativeSettingsFixture } from "./native-settings.fixture";

const storageKey = "kodex.instance.native-settings-fixture:kodex.workspace.panes.v1";

for (const shape of [
  { name: "desktop", width: 1280, hasTouch: false, isMobile: false },
  { name: "narrow fine pointer", width: 390, hasTouch: false, isMobile: false },
  { name: "narrow touch", width: 390, hasTouch: true, isMobile: true },
]) {
  test.describe(shape.name, () => {
    test.use({ viewport: { width: shape.width, height: 844 }, hasTouch: shape.hasTouch, isMobile: shape.isMobile });
    for (const hasOtherPane of [false, true]) {
      test(`closes an unavailable pane beside Browse threads (${hasOtherPane ? "another pane" : "last pane"})`, async ({ context }) => {
        const fixture = await nativeSettingsFixture(context);
        await context.addInitScript(({ key, hasOtherPane }) => {
          if (!["http:", "https:"].includes(location.protocol) || localStorage.getItem(key)) return;
          localStorage.setItem(key, JSON.stringify({
            schemaVersion: 1, activePaneId: "unavailable-pane", dockviewLayout: null,
            panes: [
              { id: "unavailable-pane", kind: "thread", title: "Missing chat", target: { mode: "existing", threadId: "missing-chat" } },
              ...(hasOtherPane ? [{ id: "other-pane", kind: "thread", title: "Other draft", target: { mode: "draft" } }] : []),
            ],
          }));
        }, { key: storageKey, hasOtherPane });
        await context.route("**/v1/threads/missing-chat**", (route) => route.fulfill({
          status: 404, json: { code: "not_found", message: "Missing thread", retryable: false },
        }));
        try {
          const page = await fixture.page("first", "/");
          await expect(page.locator(".kodex-thread-empty").getByText("Thread not found or unavailable", { exact: true })).toBeVisible();
          const close = page.getByRole("button", { name: "Close pane", exact: true });
          const browse = page.getByRole("button", { name: "Browse threads", exact: true });
          await expect(close).toBeVisible();
          await expect(browse).toBeVisible();
          const closeBox = (await close.boundingBox())!;
          const browseBox = (await browse.boundingBox())!;
          expect(closeBox.x).toBeGreaterThanOrEqual(browseBox.x + browseBox.width);
          expect(Math.abs(closeBox.y + closeBox.height / 2 - browseBox.y - browseBox.height / 2)).toBeLessThan(2);
          if (shape.hasTouch) { expect(closeBox.width).toBeGreaterThanOrEqual(44); expect(closeBox.height).toBeGreaterThanOrEqual(44); }
          await page.screenshot({ path: test.info().outputPath("unavailable-thread.png") });
          if (shape.hasTouch) await close.tap(); else await close.click();
          await expect(page.locator(".kodex-thread-empty").getByText("Thread not found or unavailable", { exact: true })).toHaveCount(0);
          await expect(page.getByRole("textbox", { name: "Message composer", exact: true })).toBeEnabled();
          await expect.poll(async () => page.evaluate((key) => {
            const state = JSON.parse(localStorage.getItem(key)!);
            return state.panes.map((pane: { id: string }) => pane.id);
          }, storageKey)).toEqual(hasOtherPane ? ["other-pane"] : [expect.stringMatching(/^thread-/)]);
          await page.reload();
          await expect(page.locator(".kodex-thread-empty").getByText("Thread not found or unavailable", { exact: true })).toHaveCount(0);
          await expect(page.getByRole("textbox", { name: "Message composer", exact: true })).toBeEnabled();
        } finally { await fixture.close(); }
        expect(fixture.unexpected).toEqual([]);
        expect(fixture.errors.filter((message) => message !== "Failed to load resource: the server responded with a status of 404 (Not Found)")).toEqual([]);
      });
    }
  });
}
