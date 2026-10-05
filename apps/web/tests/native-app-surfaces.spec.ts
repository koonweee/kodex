import { expect, test, type Locator, type Page } from "@playwright/test";

import { nativeAppSurfacesFixture } from "./native-app-surfaces.fixture";

for (const shape of [
  { name: "desktop", width: 1280, hasTouch: false, isMobile: false },
  { name: "narrow fine pointer", width: 390, hasTouch: false, isMobile: false },
  { name: "narrow touch", width: 390, hasTouch: true, isMobile: true },
]) {
  test.describe(shape.name, () => {
    test.use({ viewport: { width: shape.width, height: 844 }, hasTouch: shape.hasTouch, isMobile: shape.isMobile });
    test("generated and external apps converge across tabs, stale reads and actual stream reopen", async ({ context }) => {
      const fixture = await nativeAppSurfacesFixture(context);
      try {
        const first = await fixture.page("first");
        const second = await fixture.page("second");
        for (const page of [first, second]) await openApp(page, shape.hasTouch);
        await expect.poll(() => fixture.connected("first") && fixture.connected("second")).toBe(true);
        const connections = new Map(fixture.connections);
        await click(frame(first, "Generated chooser 1").getByRole("button", { name: "Choose A", exact: true }), shape.hasTouch);
        await expect.poll(fixture.hasPendingBridge).toBe(true);
        await expect(first.getByText("Working", { exact: true })).toBeVisible();

        for (const page of [first, second]) {
          await showChat(page, shape.width, shape.hasTouch);
          await expect(page.getByRole("button", { name: "Stop turn", exact: true })).toBeVisible();
          await expect(page.locator(".kodex-user-message-bubble").filter({ hasText: "Pick mockup A" })).toHaveCount(1);
        }
        await fixture.releaseBridge();
        for (const page of [first, second]) {
          await expect(page.locator(".kodex-user-message-bubble").filter({ hasText: "Pick mockup A" })).toHaveCount(1);
          await openApp(page, shape.hasTouch);
          await expect(page.getByText("Working", { exact: true })).toHaveCount(0);
          await expect(frame(page, "Generated chooser 1").getByRole("button", { name: "Choose A", exact: true })).toBeVisible();
        }
        // Acknowledgment leaves the artifact active. Another identical message
        // is a separate native receipt, not a one-shot submitted artifact.
        await click(frame(first, "Generated chooser 1").getByRole("button", { name: "Choose A", exact: true }), shape.hasTouch);
        await expect.poll(fixture.hasPendingBridge).toBe(true);
        await fixture.releaseBridge();
        for (const page of [first, second]) {
          await showChat(page, shape.width, shape.hasTouch);
          await expect(page.locator(".kodex-user-message-bubble").filter({ hasText: "Pick mockup A" })).toHaveCount(2);
          await openApp(page, shape.hasTouch);
        }
        expect(fixture.calls.filter(({ key }) => key === "POST /v1/app-surfaces/generated-session/bridge").map(({ body }) => body)).toEqual([
          { id: "choose", method: "ui/message", params: { role: "user", content: { type: "text", text: "Pick mockup A" } }, revision: 1, bridgeToken: "generated-session-token" },
          { id: "choose", method: "ui/message", params: { role: "user", content: { type: "text", text: "Pick mockup A" } }, revision: 1, bridgeToken: "generated-session-token" },
        ]);

        fixture.update("mcp", 1);
        for (const page of [first, second]) {
          await expect(frame(page, "External native app 1").getByText("Originating account result", { exact: true })).toBeVisible();
          await expect(frame(page, "External native app 1").getByText('{"document":"account-document"}', { exact: true })).toBeVisible();
        }
        await click(frame(first, "External native app 1").getByRole("button", { name: "Call native tool", exact: true }), shape.hasTouch);
        await expect(frame(first, "External native app 1").getByText("Account-scoped tool result", { exact: true })).toBeVisible();
        await click(frame(second, "External native app 1").getByRole("button", { name: "Read native resource", exact: true }), shape.hasTouch);
        await expect(frame(second, "External native app 1").getByText("Account-scoped resource result", { exact: true })).toBeVisible();
        await click(frame(first, "External native app 1").getByRole("button", { name: "Open ungranted link", exact: true }), shape.hasTouch);
        await expect(first.getByRole("alert")).toContainText("Link opening is not granted");
        expect(context.pages()).toHaveLength(2);

        // Capture revision one, then deliver newer gateway session events while
        // the old GET is held. Its actual request must be aborted, not hidden.
        fixture.holdSessionRead(second);
        await second.evaluate(() => window.dispatchEvent(new Event("focus")));
        await expect.poll(() => fixture.isSessionReadHeld(second)).toBe(true);
        fixture.update("mcp", 2);
        for (const page of [first, second]) await expect(frame(page, "External native app 2").getByRole("heading", { name: "External native app 2", exact: true })).toBeVisible();
        await expect.poll(() => fixture.wasSessionReadAborted(second)).toBe(true);
        await fixture.releaseSessionRead(second);
        await expect(second.getByTitle("App surface: External native app 1", { exact: true })).toHaveCount(0);
        expect(fixture.connections).toEqual(connections);

        // The other tab misses this event; only an actual EventSource reopen
        // may recover its current gateway session without a page reload.
        fixture.update("mcp", 3, "first");
        await expect(first.getByTitle("App surface: External native app 3", { exact: true })).toBeVisible();
        await expect(second.getByTitle("App surface: External native app 2", { exact: true })).toBeVisible();
        const previousConnections = fixture.connections.get("second") ?? 0;
        fixture.disconnect("second");
        await expect.poll(() => fixture.connections.get("second") ?? 0).toBeGreaterThan(previousConnections);
        await expect(frame(second, "External native app 3").getByText("Originating account result", { exact: true })).toBeVisible();
        await first.reload();
        await expect(frame(first, "External native app 3").getByText("Originating account result", { exact: true })).toBeVisible();

        fixture.archive("first");
        await expect(first.getByTitle("App surface: External native app 3", { exact: true })).toHaveCount(0);
        await expect(second.getByTitle("App surface: External native app 3", { exact: true })).toBeVisible();
        await second.evaluate(() => window.dispatchEvent(new Event("focus")));
        await expect(second.getByTitle("App surface: External native app 3", { exact: true })).toHaveCount(0);
        for (const page of [first, second]) await expect(page.getByText("No app surface session is available for this thread yet.", { exact: true })).toBeVisible();
      } finally { await fixture.close(); }
      expect(fixture.unexpected).toEqual([]);
      expect(fixture.errors).toEqual([]);
    });
  });
}

function frame(page: Page, title: string) { return page.frameLocator(`iframe[title="App surface: ${title}"]`).frameLocator('iframe[title="App surface content"]'); }
async function click(locator: Locator, touch: boolean) { if (touch) await locator.tap(); else await locator.click(); }
async function openApp(page: Page, touch: boolean) { await click(page.getByRole("button", { name: "Open app surface", exact: true }), touch); }
async function showChat(page: Page, width: number, touch: boolean) {
  if (width > 900) {
    await page.getByTestId("dockview-dv-default-tab").filter({ hasText: /^Native settings chat$/ }).click();
    return;
  }
  await click(page.getByRole("button", { name: "Switch workspace pane", exact: true }), touch);
  await click(page.getByRole("dialog", { name: "Active panes", exact: true }).getByRole("button", { name: "Native settings chat", exact: true }), touch);
}
