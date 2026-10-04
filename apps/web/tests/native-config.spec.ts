import { expect, test, type Page } from "@playwright/test";

import { nativeConfigFixture } from "./native-config.fixture";

for (const shape of [
  { name: "desktop", width: 1280, hasTouch: false, isMobile: false },
  { name: "narrow fine pointer", width: 390, hasTouch: false, isMobile: false },
  { name: "narrow touch", width: 390, hasTouch: true, isMobile: true },
]) {
  test.describe(shape.name, () => {
    test.use({ viewport: { width: shape.width, height: 844 }, hasTouch: shape.hasTouch, isMobile: shape.isMobile });
    test("native config forms retain their captured version, preserve drafts and require conflict review across tabs", async ({ context }) => {
      const fixture = await nativeConfigFixture(context);
      const patchKey = "PATCH /v1/mcp/servers/proof.with.dot";
      try {
        const first = await fixture.page("first");
        const second = await fixture.page("second");
        for (const page of [first, second]) {
          await openPreferences(page, "MCP");
          await page.getByRole("button", { name: "Edit", exact: true }).click();
          await expect(page.getByRole("dialog", { name: "Edit MCP server", exact: true })).toBeVisible();
        }
        await expect.poll(() => fixture.connected("first") && fixture.connected("second")).toBe(true);
        const original = fixture.writeTarget();
        const firstForm = first.getByRole("dialog", { name: "Edit MCP server", exact: true });
        const secondForm = second.getByRole("dialog", { name: "Edit MCP server", exact: true });
        await firstForm.getByLabel("URL", { exact: true }).fill("https://first.example/mcp");
        await secondForm.getByLabel("URL", { exact: true }).fill("https://unsaved.example/mcp");
        await firstForm.getByRole("button", { name: "Save changes", exact: true }).click();
        await expect(firstForm).toHaveCount(0);
        await expect(secondForm.getByLabel("URL", { exact: true })).toHaveValue("https://unsaved.example/mcp");
        await secondForm.getByRole("button", { name: "Save changes", exact: true }).click();
        await expect(secondForm.getByRole("button", { name: "Review latest configuration", exact: true })).toBeVisible();
        await expect(secondForm.getByLabel("URL", { exact: true })).toHaveValue("https://unsaved.example/mcp");
        await expect(secondForm.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
        await second.screenshot({ path: test.info().outputPath("native-config-conflict.png") });
        expect(fixture.requests.filter(({ key }) => key === patchKey).map(({ body }) => body)).toEqual([
          { writeTarget: original, edits: [{ keyPath: ["url"], value: "https://first.example/mcp" }] },
          { writeTarget: original, edits: [{ keyPath: ["url"], value: "https://unsaved.example/mcp" }] },
        ]);
        expect(fixture.native.url).toBe("https://first.example/mcp");
        await secondForm.getByRole("button", { name: "Review latest configuration", exact: true }).click();
        await expect(secondForm.getByLabel("URL", { exact: true })).toHaveValue("https://first.example/mcp");
        await secondForm.getByLabel("URL", { exact: true }).fill("https://reviewed.example/mcp");
        const reviewed = fixture.writeTarget();
        await secondForm.getByRole("button", { name: "Save changes", exact: true }).click();
        await expect(secondForm).toHaveCount(0);
        expect(fixture.requests.filter(({ key }) => key === patchKey).at(-1)?.body).toEqual({
          writeTarget: reviewed, edits: [{ keyPath: ["url"], value: "https://reviewed.example/mcp" }],
        });
        expect(fixture.native.http_headers).toEqual({ Authorization: "fixture-private-secret", "X.Proof.Key": "private-header" });
        expect(fixture.native.disabled_tools).toEqual(["protected-tool"]);
        for (const page of [first, second]) {
          await expectMcpUrl(page, "https://reviewed.example/mcp");
          await expect(page.locator("body")).not.toContainText("fixture-private-secret");
        }
        // The first client misses a global marker; reopening its EventSource
        // refills config without another runtime or a browser reload.
        fixture.externalChange({ url: "https://reconnected.example/mcp" }, "second");
        await expectMcpUrl(second, "https://reconnected.example/mcp");
        const connections = fixture.connections.get("first") ?? 0;
        fixture.disconnect("first");
        await expect.poll(() => fixture.connections.get("first") ?? 0).toBeGreaterThan(connections);
        await expectMcpUrl(first, "https://reconnected.example/mcp");
      } finally { await fixture.close(); }
      expect(fixture.unexpected).toEqual([]);
      // Chromium reports the deliberately exercised409 at network-console level.
      expect(fixture.errors.filter((error) => error !== "Failed to load resource: the server responded with a status of 409 (Conflict)")).toEqual([]);
    });

    test("a saved MCP edit converges despite reload failure and retry reload does not rewrite config", async ({ context }) => {
      const fixture = await nativeConfigFixture(context);
      try {
        const first = await fixture.page("first");
        const second = await fixture.page("second");
        for (const page of [first, second]) await openPreferences(page, "MCP");
        await expect.poll(() => fixture.connected("first") && fixture.connected("second")).toBe(true);
        fixture.failReload("Fixture runtime reload failed");
        await first.getByRole("button", { name: "Edit", exact: true }).click();
        const form = first.getByRole("dialog", { name: "Edit MCP server", exact: true });
        await form.getByLabel("URL", { exact: true }).fill("https://saved.example/mcp");
        await form.getByRole("button", { name: "Save changes", exact: true }).click();
        await expect(form).toHaveCount(0);
        await expect(first.getByRole("dialog", { name: "Preferences", exact: true })).toContainText("Fixture runtime reload failed");
        await expectMcpUrl(second, "https://saved.example/mcp");
        await first.getByRole("button", { name: "Reload MCP servers", exact: true }).click();
        await expect.poll(() => fixture.requests.filter(({ key }) => key === "POST /v1/mcp/reload").length).toBe(1);
        expect(fixture.requests.filter(({ key }) => key === "PATCH /v1/mcp/servers/proof.with.dot")).toHaveLength(1);
        expect(fixture.native.http_headers.Authorization).toBe("fixture-private-secret");
        await first.getByRole("button", { name: "Execution", exact: true }).click();
        await second.getByRole("button", { name: "Execution", exact: true }).click();
        const target = fixture.writeTarget();
        await first.getByRole("radiogroup", { name: "Approval review", exact: true }).getByText("Auto review", { exact: true }).click();
        await expect.poll(() => fixture.requests.filter(({ key }) => key === "PATCH /v1/composer-settings").map(({ body }) => body)).toEqual([
          { writeTarget: target, approvalsReviewer: "auto_review" },
        ]);
        await expect(second.getByRole("radio", { name: "Auto review", exact: true })).toBeChecked();
      } finally { await fixture.close(); }
      expect(fixture.unexpected).toEqual([]);
      expect(fixture.errors).toEqual([]);
    });
  });
}

async function openPreferences(page: Page, panel: string) {
  const sidebar = page.getByRole("navigation", { name: "Workspace", exact: true });
  if (!await sidebar.isVisible()) await page.getByRole("button", { name: /^(Show sidebar|Projects)$/i }).click();
  await sidebar.getByRole("button", { name: "Account settings", exact: true }).click();
  await page.getByRole("menuitem", { name: "Preferences", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Preferences", exact: true })).toBeVisible();
  await page.getByRole("button", { name: panel, exact: true }).click();
}

async function expectMcpUrl(page: Page, value: string) {
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const form = page.getByRole("dialog", { name: "Edit MCP server", exact: true });
  await expect(form.getByLabel("URL", { exact: true })).toHaveValue(value);
  await form.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(form).toHaveCount(0);
}
