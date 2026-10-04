import { expect, test } from "@playwright/test";
import type { AutomationRun } from "../src/api/client";
import { nativeSettingsFixture } from "./native-settings.fixture";

for (const shape of [
  { name: "desktop", width: 1280, hasTouch: false, isMobile: false },
  { name: "narrow fine pointer", width: 390, hasTouch: false, isMobile: false },
  { name: "narrow touch", width: 390, hasTouch: true, isMobile: true },
]) {
  test.describe(shape.name, () => {
    test.use({ viewport: { width: shape.width, height: 844 }, hasTouch: shape.hasTouch, isMobile: shape.isMobile });
    test("automation admission state converges without retrying uncertain runs", async ({ context }) => {
      const fixture = await nativeSettingsFixture(context);
      const automationId = "scheduled-review";
      fixture.automations.push({ id: automationId, name: "Scheduled review", prompt: "Review current changes", targetThreadId: "settings-chat", schedule: { startAt: "2026-10-05T00:00:00Z", repeatEvery: { value: 1, unit: "hours" } }, nextRunAt: "2026-10-05T01:00:00Z", status: "active", consecutiveFailureCount: 0, createdAt: "2026-10-05T00:00:00Z", updatedAt: "2026-10-05T00:00:00Z" });
      const run: AutomationRun = { id: "run-1", automationId, targetThreadId: "settings-chat", nativeQueueId: "native-row", phase: "queued", createdAt: "2026-10-05T00:00:00Z", updatedAt: "2026-10-05T00:00:00Z" };
      fixture.automationRuns.set(automationId, [run]);
      try {
        const first = await fixture.page("first", "/automations");
        const second = await fixture.page("second", "/automations");
        for (const page of [first, second]) {
          const row = page.getByText("Scheduled review", { exact: true });
          if (shape.hasTouch) await row.tap(); else await row.click();
          await expect(page.getByRole("region", { name: "Automation runs" }).getByText("Queued", { exact: true })).toBeVisible();
        }
        await expect.poll(() => fixture.connected("first") && fixture.connected("second")).toBe(true);
        const connections = new Map(fixture.connections);
        fixture.holdNext("second", "runs");
        fixture.automationRunChanged(automationId, "second");
        await expect.poll(() => fixture.isHeld("second", "runs")).toBe(true);
        Object.assign(run, { phase: "uncertain", error: "Native admission acknowledgement lost" });
        fixture.automationRunChanged(automationId);
        for (const page of [first, second]) {
          const history = page.getByRole("region", { name: "Automation runs" });
          await expect(history.getByText("Delivery uncertain", { exact: true })).toBeVisible();
          await expect(history).toContainText("will not be automatically resubmitted");
          await expect(history.getByRole("button", { name: /retry|resend/i })).toHaveCount(0);
        }
        await expect.poll(() => fixture.wasAborted("second", "runs")).toBe(true);
        await fixture.release("second", "runs");
        await expect(second.getByText("Delivery uncertain", { exact: true })).toBeVisible();
        expect(fixture.connections).toEqual(connections);
        Object.assign(run, { phase: "dispatched", turnId: "native-turn", error: null });
        fixture.automationRunChanged(automationId, "first");
        await expect(first.getByText("Dispatched", { exact: true })).toBeVisible();
        await expect(second.getByText("Delivery uncertain", { exact: true })).toBeVisible();
        const before = fixture.connections.get("second") ?? 0;
        fixture.disconnect("second");
        await expect.poll(() => fixture.connections.get("second") ?? 0).toBeGreaterThan(before);
        await expect(second.getByText("Dispatched", { exact: true })).toBeVisible();
        expect(fixture.requests.filter((request) => request.key.includes("/automations") && !request.key.startsWith("GET "))).toEqual([]);
      } finally { await fixture.close(); }
      expect(fixture.unexpected).toEqual([]);
      expect(fixture.errors).toEqual([]);
    });
  });
}
