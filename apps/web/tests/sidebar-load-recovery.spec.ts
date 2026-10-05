import { expect, test, type Page } from "@playwright/test";

import { nativeProjectsFixture } from "./native-projects.fixture";

for (const shape of [
  { name: "desktop", width: 1280, hasTouch: false, isMobile: false },
  { name: "narrow fine pointer", width: 390, hasTouch: false, isMobile: false },
  { name: "narrow touch", width: 390, hasTouch: true, isMobile: true },
]) {
  test.describe(shape.name, () => {
    test.use({ viewport: { width: shape.width, height: 844 }, hasTouch: shape.hasTouch, isMobile: shape.isMobile });

    test("sidebar failures remain visible and explicit retry converges after a missed native change", async ({ context }) => {
      const fixture = await nativeProjectsFixture(context);
      let failInitial = true;
      let failingClient: Page | undefined;
      let failedReads = 0;
      await context.route("**/v1/sidebar/threads", async (route) => {
        if (failInitial || route.request().frame().page() === failingClient) {
          failedReads += 1;
          await route.fulfill({ status: 500, json: { code: "internal", message: "database is locked", retryable: false } });
        } else await route.fallback();
      });
      try {
        const first = await fixture.page("first", "/");
        const firstSidebar = await openSidebar(first);
        await expect(firstSidebar.getByRole("alert")).toContainText("Could not load sidebar");
        await expect(firstSidebar.getByText("No projects", { exact: true })).toHaveCount(0);
        failInitial = false;
        await firstSidebar.getByRole("button", { name: "Retry", exact: true }).click();
        await expect(firstSidebar.getByRole("group", { name: "Alpha", exact: true })).toBeVisible();
        await expect(firstSidebar.getByRole("alert")).toHaveCount(0);
        const second = await fixture.page("second", "/");
        const secondSidebar = await openSidebar(second);
        await expect(secondSidebar.getByRole("group", { name: "Alpha", exact: true })).toBeVisible();
        await expect.poll(() => fixture.connected("first") && fixture.connected("second")).toBe(true);

        fixture.state.projects[0].name = "Recovered Alpha";
        fixture.emit("project.changed", { projectId: "alpha", changeType: "updated" }, "first");
        await expect(firstSidebar.getByRole("group", { name: "Recovered Alpha", exact: true })).toBeVisible();
        await expect(secondSidebar.getByRole("group", { name: "Alpha", exact: true })).toBeVisible();
        failingClient = second;
        const beforeReconnect = fixture.connections.get("second") ?? 0;
        fixture.disconnect("second");
        await expect.poll(() => fixture.connections.get("second") ?? 0).toBeGreaterThan(beforeReconnect);
        await expect(secondSidebar.getByRole("alert")).toContainText("Could not load sidebar");
        await expect(secondSidebar.getByRole("group", { name: "Alpha", exact: true })).toBeVisible();
        await expect(secondSidebar.getByText("No projects", { exact: true })).toHaveCount(0);
        await second.screenshot({ path: test.info().outputPath("sidebar-refill-error.png") });
        failingClient = undefined;
        await secondSidebar.getByRole("button", { name: "Retry", exact: true }).click();
        await expect(secondSidebar.getByRole("group", { name: "Recovered Alpha", exact: true })).toBeVisible();
        await expect(secondSidebar.getByRole("alert")).toHaveCount(0);
        expect(fixture.unexpected).toEqual([]);
        const expectedNetworkError = "Failed to load resource: the server responded with a status of 500 (Internal Server Error)";
        expect(failedReads).toBeGreaterThanOrEqual(2);
        expect(fixture.errors.every((error) => error === expectedNetworkError)).toBe(true);
      } finally { await fixture.close(); }
    });
  });
}

async function openSidebar(page: Page) {
  const sidebar = page.getByRole("navigation", { name: "Workspace", exact: true });
  if (!await sidebar.isVisible()) await page.getByRole("button", { name: /^(Show sidebar|Projects)$/i }).click();
  await expect(sidebar).toBeVisible();
  return sidebar;
}
