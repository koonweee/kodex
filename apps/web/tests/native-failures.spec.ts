import { expect, test } from "@playwright/test";
import { nativeSettingsFixture } from "./native-settings.fixture";

test("failed turns remain visible across live delivery, missed events and reload", async ({ context }) => {
  const fixture = await nativeSettingsFixture(context);
  try {
    const first = await fixture.page("first");
    const second = await fixture.page("second");
    await expect.poll(() => fixture.connected("first") && fixture.connected("second")).toBe(true);
    fixture.detail.timeline = {
      ...fixture.detail.timeline, viewRevision: 5, activeTurnId: null, liveState: "idle",
      turns: [{ id: "failed-turn", status: "failed", errorMessage: "Sign in to continue." }],
      rows: [{
        id: "work-failed-turn", kind: "work", turnId: "failed-turn", displayOrder: 1,
        status: "failed",
        work: { state: "failed", startedAt: null, completedAt: null, errorMessage: "Sign in to continue." },

      }],
    };
    fixture.publishTimeline(fixture.detail.timeline, "first");
    await expect(first.getByRole("alert").filter({ hasText: "Sign in to continue." })).toBeVisible();
    const opens = fixture.connections.get("second") ?? 0;
    fixture.disconnect("second");
    await expect.poll(() => fixture.connections.get("second") ?? 0).toBeGreaterThan(opens);
    await expect(second.getByRole("alert").filter({ hasText: "Sign in to continue." })).toBeVisible();
    await first.reload();
    await expect(first.getByRole("alert").filter({ hasText: "Sign in to continue." })).toBeVisible();
    expect(fixture.unexpected).toEqual([]);
    expect(fixture.errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});
