import { expect, test } from "@playwright/test";
import { nativeSettingsFixture } from "./native-settings.fixture";

for (const width of [1280, 390]) {
  test(`incompatible deployment preserves drafts in two tabs (${width}px)`, async ({ context }) => {
    const fixture = await nativeSettingsFixture(context);
    try {
      const first = await fixture.page("first");
      const second = await fixture.page("second");
      await first.setViewportSize({ width, height: 844 });
      await second.setViewportSize({ width, height: 844 });
      const pane = (page: typeof first) => page.locator('.kodex-thread-pane[data-workspace-pane-active="true"]');
      const composer = (page: typeof first) => pane(page).getByLabel("Message composer", { exact: true });
      await composer(first).fill("first unsent draft");
      await composer(second).fill("second unsent draft");
      let writes = 0;
      await first.route("**/v1/threads/*/input", async (route) => {
        writes += 1;
        expect(route.request().headers()["x-kodex-api-version"]).toBe("2");
        await route.fulfill({ status: 409, headers: { "x-kodex-api-version": "future" }, json: { code: "client_update_required", message: "Update Kodex before making changes.", retryable: false } });
      });
      await pane(first).getByRole("button", { name: "Send message", exact: true }).click();
      await expect(first.getByText("Update Kodex to continue")).toBeVisible();
      await expect(composer(first)).toHaveValue("first unsent draft");
      await pane(first).getByRole("button", { name: "Send message", exact: true }).click();
      expect(writes).toBe(1);
      await expect(composer(second)).toHaveValue("second unsent draft");
      await second.route("**/v1/capabilities", (route) => route.fulfill({ json: { gateway: { instanceId: "native-settings-fixture", apiVersion: "future" } } }));
      await second.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(second.getByText("Update Kodex to continue")).toBeVisible();
      await expect(composer(second)).toHaveValue("second unsent draft");
      await first.screenshot({ path: test.info().outputPath("update-required.png") });
    } finally { await fixture.close(); }
    expect(fixture.unexpected).toEqual([]);
  });
}
