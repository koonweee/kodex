import { expect, test } from "@playwright/test";
import { nativeSettingsFixture } from "./native-settings.fixture";

for (const { width, hasTouch } of [{ width: 1280, hasTouch: false }, { width: 390, hasTouch: false }, { width: 390, hasTouch: true }]) {
  test.describe(`viewport ${width}, touch ${hasTouch}`, () => {
    test.use({ hasTouch, viewport: { width, height: 900 } });
    test(`New chat reuses its draft across projects at ${width}px touch=${hasTouch}`, async ({ context }) => {
      const fixture = await nativeSettingsFixture(context);
      const projects = ["Alpha", "Beta"].map((name, i) => ({ id: `project-${i}`, name, roots: [{ path: `/projects/${name}` }], metadata: {}, position: i, createdAt: 0, updatedAt: 0, recencyAt: null }));
      await context.route("**/v1/projects", (route) => route.fulfill({ json: { projects } }));
      await context.route(/\/v1\/sidebar\/threads(?:\?.*)?$/, (route) => route.fulfill({ json: { projects, projectThreads: {}, chatThreads: { threads: [] }, pinnedThreads: { threads: [] } } }));
      await context.route(/\/v1\/threads(?:\?.*)?$/, (route) => route.fulfill({ json: { threads: [], nextCursor: null } }));
      try {
        const page = await fixture.page("drafts", "/");

        const composer = page.getByRole("textbox", { name: /message composer/i });
        await composer.fill("Keep this draft");
        await page.locator('input[type="file"]').setInputFiles({ name: "draft.txt", mimeType: "text/plain", buffer: Buffer.from("Keep attachment") });
        for (const name of ["Alpha", "Beta", "Alpha"]) {
          const collapse = page.getByRole("button", { name: "Collapse composer", exact: true });
          if (await collapse.isVisible()) await collapse.click();
          if (width < 900) await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
          await page.getByRole("button", { name: `Create thread in ${name}`, exact: true }).click();
          await expect(composer).toHaveCount(1);
          await expect(composer).toHaveValue("Keep this draft");
          await expect(page.getByText("draft.txt", { exact: true })).toBeVisible();
          await expect(page.locator(".kodex-thread-pane")).toHaveCount(1);
          await expect(page.getByRole("button", { name: `Project: ${name}`, exact: true })).toContainText(name);
        }
      } finally { await fixture.close(); }
      expect(fixture.errors).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    });
  });
}
