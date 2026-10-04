import { expect, test, type Page } from "@playwright/test";

import { nativeSettingsFixture } from "./native-settings.fixture";

for (const shape of [
  { name: "desktop", width: 1280, hasTouch: false, isMobile: false },
  { name: "narrow fine pointer", width: 390, hasTouch: false, isMobile: false },
  { name: "narrow touch", width: 390, hasTouch: true, isMobile: true },
]) {
  test.describe(shape.name, () => {
    test.use({ viewport: { width: shape.width, height: 844 }, hasTouch: shape.hasTouch, isMobile: shape.isMobile });

    test("native settings converge across tabs and recover missed changes without resubmitting snapshots", async ({ context }) => {
      const fixture = await nativeSettingsFixture(context);
      const settingsKey = "GET /v1/threads/settings-chat/settings";
      const patchKey = "PATCH /v1/threads/settings-chat/settings";
      const reads = (client: string) => fixture.requests.filter((entry) => entry.client === client && entry.key === settingsKey).length;
      try {
        const first = await fixture.page("first");
        const second = await fixture.page("second");
        for (const page of [first, second]) await expect(modelButton(page, "medium")).toBeVisible();
        await expect.poll(() => fixture.connected("first") && fixture.connected("second")).toBe(true);
        const initialConnections = new Map(fixture.connections);

        const firstReads = reads("first");
        await modelButton(first, "medium").click();
        await first.getByRole("menuitemcheckbox", { name: "Fast", exact: true }).click();
        await expect.poll(() => fixture.pending).toEqual([{ serviceTier: "fast" }]);
        await expect.poll(() => reads("first")).toBeGreaterThan(firstReads);
        await expect(modelButton(first, "medium")).toBeEnabled();
        await expect(first.getByRole("img", { name: "Fast responses enabled" })).toHaveCount(0);
        expect(fixture.settings.serviceTier).toBeNull();

        // Only the first tab receives this application marker. The second must
        // submit just its changed field from its still-stale visible settings.
        fixture.applyNext("first");
        await expect(first.getByRole("img", { name: "Fast responses enabled" })).toBeVisible();
        await expect(second.getByRole("img", { name: "Fast responses enabled" })).toHaveCount(0);
        await modelButton(second, "medium").click();
        await second.getByRole("menuitem", { name: "High", exact: true }).click();
        await expect.poll(() => fixture.pending).toEqual([{ effort: "high" }]);
        await expect(modelButton(second, "medium")).toBeVisible();
        fixture.applyNext();
        for (const page of [first, second]) {
          await expect(modelButton(page, "high")).toBeVisible();
          await expect(page.getByRole("img", { name: "Fast responses enabled" })).toBeVisible();
        }
        expect(fixture.settings).toMatchObject({ effort: "high", serviceTier: "fast" });
        expect(fixture.requests.filter((entry) => entry.key === patchKey).map((entry) => entry.body))
          .toEqual([{ serviceTier: "fast" }, { effort: "high" }]);
        expect(fixture.connections).toEqual(initialConnections);

        // A captured old settings response cannot overwrite a later native read.
        fixture.holdNext("second");
        fixture.settingsChanged("second");
        await expect.poll(() => fixture.isHeld("second")).toBe(true);
        expect(fixture.wasAborted("second")).toBe(false);
        Object.assign(fixture.settings, { effort: "medium", serviceTier: null });
        fixture.settingsChanged();
        for (const page of [first, second]) await expect(modelButton(page, "medium")).toBeVisible();
        await expect.poll(() => fixture.wasAborted("second")).toBe(true);
        await fixture.release("second");
        await expect(modelButton(second, "medium")).toBeVisible();
        await expect(second.getByRole("img", { name: "Fast responses enabled" })).toHaveCount(0);
        expect(fixture.connections).toEqual(initialConnections);

        // No settings event reaches the second tab. Actual EventSource reopening
        // must initiate an authoritative read without reloading the page.
        Object.assign(fixture.settings, { effort: "high", serviceTier: "fast" });
        fixture.settingsChanged("first");
        await expect(modelButton(first, "high")).toBeVisible();
        await expect(modelButton(second, "medium")).toBeVisible();
        const beforeReconnect = fixture.connections.get("second") ?? 0;
        const readsBeforeReconnect = reads("second");
        fixture.disconnect("second");
        await expect.poll(() => fixture.connections.get("second") ?? 0).toBeGreaterThan(beforeReconnect);
        await expect(modelButton(second, "high")).toBeVisible();
        await expect(second.getByRole("img", { name: "Fast responses enabled" })).toBeVisible();
        expect(reads("second")).toBeGreaterThan(readsBeforeReconnect);

        await send(first, "Use native settings", shape.hasTouch);
        await expect.poll(() => fixture.requests.filter((entry) => entry.key === "POST /v1/threads/settings-chat/input").map((entry) => entry.body))
          .toEqual([{ input: [{ type: "text", text: "Use native settings" }], clientUserMessageId: expect.any(String) }]);
        await expect(activePane(second).getByRole("button", { name: "Stop turn", exact: true })).toBeVisible();
        await send(second, "Use native settings when queued", shape.hasTouch);
        await expect.poll(() => fixture.requests.filter((entry) => entry.key === "POST /v1/threads/settings-chat/queued-inputs").map((entry) => entry.body))
          .toEqual([{ input: [{ type: "text", text: "Use native settings when queued" }] }]);
        for (const page of [first, second]) await expect(activePane(page).getByRole("region", { name: "Queued steer messages" })).toContainText("Use native settings when queued");
        expect(fixture.requests.filter((entry) => entry.key.startsWith("PATCH") && entry.key !== patchKey)).toEqual([]);
      } finally {
        await fixture.close();
      }
      expect(fixture.unexpected).toEqual([]);
      expect(fixture.errors).toEqual([]);
    });
  });
}

function modelButton(page: Page, effort: string) {
  return activePane(page).getByRole("button", { name: `Model: gpt-5.4, ${effort}`, exact: true });
}

async function send(page: Page, text: string, hasTouch: boolean) {
  const composer = activePane(page).getByLabel("Message composer", { exact: true });
  // Touch focus opens a replacement expanded editor. Resolve it after the tap
  // before entering text, just as a phone user does before typing.
  if (hasTouch) {
    await composer.tap();
    await expect(activePane(page).getByRole("dialog", { name: "Compose", exact: true })).toBeVisible();
  }
  await composer.fill(text);
  await expect(composer).toHaveValue(text);
  const submit = activePane(page).getByRole("button", { name: "Send message", exact: true });
  if (hasTouch) await submit.tap();
  else await submit.click();
}

function activePane(page: Page) {
  return page.locator('.kodex-thread-pane[data-workspace-pane-active="true"]');
}
