import { expect, test } from "@playwright/test";
import { nativeSettingsFixture } from "./native-settings.fixture";

for (const method of ["enter", "click"] as const) {
  test(`normal ${method} follows the gateway queue even when this tab missed its creation`, async ({ context }) => {
    const fixture = await nativeSettingsFixture(context);
    try {
      const first = await fixture.page("first");
      const second = await fixture.page("second");
      await expect.poll(() => fixture.connected("first") && fixture.connected("second")).toBe(true);
      // Native queue changed in another client; first has not received its refill.
      fixture.queuedInputs.push({ id: "other-tab", threadId: "settings-chat", clientUserMessageId: "other", input: [{ type: "text", text: "Earlier queued work" }], attachments: [], canSteer: false });
      fixture.queueChanged("second");
      await expect(second.getByText("Earlier queued work", { exact: true })).toBeVisible();
      const activePane = first.locator('.kodex-thread-pane[data-workspace-pane-active="true"]');
      const composer = activePane.getByRole("textbox", { name: "Message composer", exact: true });
      await composer.fill("Next queued work");
      if (method === "enter") await composer.press("Enter");
      else await activePane.getByRole("button", { name: "Send message", exact: true }).click();
      await expect.poll(() => fixture.queuedInputs.length).toBe(2);
      for (const page of [first, second]) {
        await expect(page.getByText("Next queued work", { exact: true })).toHaveCount(1);
      }
      await expect(composer).toHaveValue("");
      await composer.fill("Another draft");
      await expect(activePane.getByRole("button", { name: "Add to queue", exact: true })).toBeVisible();
      expect(fixture.requests.filter(request => request.key === "POST /v1/threads/settings-chat/input")).toHaveLength(1);
      expect(fixture.requests.filter(request => request.key === "POST /v1/threads/settings-chat/queued-inputs")).toHaveLength(0);
    } finally { await fixture.close(); }
    expect(fixture.errors).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });
}
