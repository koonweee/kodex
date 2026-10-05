import { expect, test, type Locator, type Page } from "@playwright/test";

import { nativeProjectsFixture, preservedHistory } from "./native-projects.fixture";
import { pickerHome, pickerRoot, projectDirectoriesFixture } from "./project-directories.fixture";

for (const shape of [
  { name: "desktop", width: 1280, hasTouch: false, isMobile: false },
  { name: "narrow fine pointer", width: 390, hasTouch: false, isMobile: false },
  { name: "narrow touch", width: 390, hasTouch: true, isMobile: true },
]) {
  test.describe(shape.name, () => {
    test.use({ viewport: { width: shape.width, height: 844 }, hasTouch: shape.hasTouch, isMobile: shape.isMobile });
    test("browses home directories and creates one project across tabs after a lost reply", async ({ context }) => {
      const fixture = await nativeProjectsFixture(context);
      const directories = await projectDirectoriesFixture(context, true);
      try {
        const first = await fixture.page("first", "/threads/history");
        const second = await fixture.page("second", "/threads/history");
        await expect.poll(() => fixture.connected("first") && fixture.connected("second")).toBe(true);
        const connections = new Map(fixture.connections);
        const secondSidebar = await openSidebar(second);
        await openSidebar(first);
        await click(first.getByRole("button", { name: "Add project", exact: true }), shape.hasTouch);
        const dialog = first.getByRole("dialog", { name: "Add project", exact: true });
        const add = dialog.getByRole("button", { name: "Add project", exact: true });
        await expect(dialog.getByText(pickerHome, { exact: true })).toBeVisible();
        await expect(dialog.getByRole("button", { name: "Go up", exact: true })).toBeDisabled();
        await expect(add).toBeDisabled();
        expect(directories.requestedPaths[0]).toBeNull();
        await first.screenshot({ path: test.info().outputPath("picker-open.png") });

        await click(dialog.getByRole("button", { name: "repos", exact: true }), shape.hasTouch);
        await click(dialog.getByRole("button", { name: "Research", exact: true }), shape.hasTouch);
        await expect(dialog.getByRole("alert")).toContainText("Directory unavailable");
        await expect(dialog.getByRole("button", { name: "Use this directory", exact: true })).toBeHidden();
        await expect(add).toBeDisabled();
        await click(dialog.getByRole("button", { name: "Retry", exact: true }), shape.hasTouch);
        await expect(dialog.getByText(pickerRoot, { exact: true })).toBeVisible();
        await click(dialog.getByRole("button", { name: "drafts", exact: true }), shape.hasTouch);
        await expect(dialog.getByText(`${pickerRoot}/drafts`, { exact: true })).toBeVisible();
        await click(dialog.getByRole("button", { name: "Go up", exact: true }), shape.hasTouch);
        await expect(dialog.getByText(pickerRoot, { exact: true })).toBeVisible();
        await click(dialog.getByRole("button", { name: "Use this directory", exact: true }), shape.hasTouch);
        await expect(dialog.getByText(pickerRoot, { exact: true })).toBeVisible();
        await expect(dialog.getByRole("button", { name: "drafts", exact: true })).toBeHidden();
        await expect(add).toBeEnabled();
        await first.screenshot({ path: test.info().outputPath("selected-root.png") });

        await click(dialog.getByRole("button", { name: "Remove root directory", exact: true }), shape.hasTouch);
        await expect(add).toBeDisabled();
        await expect(dialog.getByText(pickerRoot, { exact: true })).toBeVisible();
        await expect(dialog.getByRole("button", { name: "drafts", exact: true })).toBeVisible();
        await click(dialog.getByRole("button", { name: "Go up", exact: true }), shape.hasTouch);
        await click(dialog.getByRole("button", { name: "Go up", exact: true }), shape.hasTouch);
        await expect(dialog.getByText(pickerHome, { exact: true })).toBeVisible();
        await expect(dialog.getByRole("button", { name: "Go up", exact: true })).toBeDisabled();
        await click(dialog.getByRole("button", { name: "repos", exact: true }), shape.hasTouch);
        await click(dialog.getByRole("button", { name: "Research", exact: true }), shape.hasTouch);
        await click(dialog.getByRole("button", { name: "Use this directory", exact: true }), shape.hasTouch);
        fixture.failNextCreateReply();
        await click(add, shape.hasTouch);
        await expect(dialog.getByText("Create reply lost; retry this intent.")).toBeVisible();
        await expect(secondSidebar.getByRole("group", { name: "Research", exact: true })).toBeVisible();
        const draftSettingsRead = first.waitForRequest((request) => {
          const url = new URL(request.url());
          return url.pathname === "/v1/composer-settings" && url.searchParams.get("projectId") === "created-1";
        });
        await click(add, shape.hasTouch);
        await expect(dialog).toBeHidden();
        expect(new URL((await draftSettingsRead).url()).searchParams.get("cwd")).toBe(pickerRoot);
        await expect(first.locator('.kodex-thread-pane[data-workspace-pane-active="true"]').getByRole("textbox", { name: "Message composer", exact: true })).toBeEnabled();
        const attempts = fixture.requests.filter((request) => request.key === "POST /v1/projects");
        expect(attempts).toHaveLength(2);
        expect(attempts[0].body).toEqual({ name: "Research", roots: [{ path: pickerRoot }], idempotencyKey: expect.any(String) });
        expect(attempts[1].body).toEqual(attempts[0].body);
        expect(fixture.state.projects.filter((project) => project.name === "Research")).toHaveLength(1);
        expect(fixture.connections).toEqual(connections);
        expect(directories.requestedPaths.every((path) => path === null || path.startsWith(pickerHome))).toBe(true);
        if (shape.width < 700) await second.getByRole("button", { name: "Show thread", exact: true }).click();
        await expect(second.getByText(preservedHistory, { exact: true })).toBeVisible();
        await first.screenshot({ path: test.info().outputPath("created-root-project.png") });
      } finally {
        await fixture.close();
      }
      expect(fixture.unexpected).toEqual([]);
      expect(fixture.errors).toEqual(["Failed to load resource: the server responded with a status of 404 (Not Found)"]);
      expect(fixture.expectedCreateErrors).toHaveLength(1);
    });
  });
}

async function click(locator: Locator, touch: boolean) { if (touch) await locator.tap(); else await locator.click(); }
async function openSidebar(page: Page) {
  const sidebar = page.getByRole("navigation", { name: "Workspace", exact: true });
  if (!await sidebar.isVisible()) await page.getByRole("button", { name: /^(Show sidebar|Projects)$/i }).click();
  await expect(sidebar).toBeVisible();
  return sidebar;
}
