import { expect, test } from "@playwright/test";
import type { ThreadSubagentSummary, ThreadViewResponse } from "../src/api/client";
import { nativeSettingsFixture } from "./native-settings.fixture";

for (const shape of [
  { name: "desktop", width: 1280, hasTouch: false, isMobile: false },
  { name: "narrow fine pointer", width: 390, hasTouch: false, isMobile: false },
  { name: "narrow touch", width: 390, hasTouch: true, isMobile: true },
]) {
  test.describe(shape.name, () => {
    test.use({ viewport: { width: shape.width, height: 844 }, hasTouch: shape.hasTouch, isMobile: shape.isMobile });
    test("native descendant pages include unloaded children and converge across tabs", async ({ context }) => {
      const fixture = await nativeSettingsFixture(context);
      const scout: ThreadSubagentSummary = {
        id: "native-scout", parentThreadId: "settings-chat", name: null, preview: "Scout work",
        agentNickname: "Scout", agentRole: "explorer", status: "notLoaded",
        canAcceptDirectInput: null, updatedAt: 0,
      };
      const reviewer: ThreadSubagentSummary = {
        ...scout, id: "native-reviewer", agentNickname: "Reviewer", agentRole: null,
        parentThreadId: "unloaded-parent", status: "idle", canAcceptDirectInput: false,
      };
      let rows = [scout, reviewer];
      const pages: string[] = [];
      const mutations: string[] = [];
      const childReads: string[] = [];
      await context.route("**/v1/threads/**", async (route) => {
        const url = new URL(route.request().url());
        const method = route.request().method();
        if (url.pathname === "/v1/threads/settings-chat/subagents") {
          if (method !== "GET" || (url.searchParams.has("cursor") && url.searchParams.get("cursor") !== "native-next")) {
            fixture.unexpected.push(`${method} ${url.pathname}${url.search}`);
            return route.fulfill({ status: 400, json: { code: "bad_request", message: "Unexpected descendant request", retryable: false } });
          }
          pages.push(url.search);
          const offset = url.searchParams.has("cursor") ? 1 : 0;
          return route.fulfill({ json: { subagents: rows.slice(offset, offset + 1), nextCursor: offset === 0 && rows.length > 1 ? "native-next" : null } });
        }
        const child = [scout, reviewer].find((row) => ["", "/attach", "/subagents", "/app-surface", "/settings", "/queued-inputs"].some((suffix) => url.pathname === `/v1/threads/${row.id}${suffix}`));
        if (url.pathname.startsWith("/v1/threads/native-") && method !== "GET") mutations.push(`${method} ${url.pathname}`);
        if (child && (method === "GET" || (method === "POST" && url.pathname.endsWith("/attach")))) {
          if (url.pathname.endsWith("/subagents")) return route.fulfill({ json: { subagents: [], nextCursor: null } });
          if (url.pathname.endsWith("/app-surface")) return route.fulfill({ json: { session: null } });
          if (url.pathname.endsWith("/settings")) return route.fulfill({ json: fixture.settings });
          if (url.pathname.endsWith("/queued-inputs")) return route.fulfill({ json: { queuedInputs: [] } });
          childReads.push(child.id);
          const detail: ThreadViewResponse = {
            thread: { ...child, cwd: "/native/child", projectId: null, createdAt: 0, notificationsEnabled: true, seenCompletedAgentTurnSeq: 0, unreadCompletedAgentTurn: false },
            liveState: child.status === "notLoaded" ? "notLoaded" : "idle",
            timeline: { activeTurnId: null, liveState: child.status === "notLoaded" ? "notLoaded" : "idle", pendingApprovalRequests: [], pendingUserInputRequests: [], rows: [], turns: [], viewRevision: 1 },
          };
          return route.fulfill({ json: detail });
        }
        return route.fallback();
      });
      try {
        const first = await fixture.page("first");
        const second = await fixture.page("second");
        for (const page of [first, second]) {
          await page.getByRole("button", { name: "Show subagents", exact: true }).click();
          const viewer = page.getByRole("complementary", { name: "Subagent thread viewer", exact: true });
          await expect(viewer).toContainText("Scout");
          await expect(viewer).toContainText("Not loaded");
          await viewer.getByRole("button", { name: "Load more subagents", exact: true }).click();
          await viewer.getByLabel("Subagent", { exact: true }).click();
          await page.getByRole("option", { name: "Reviewer", exact: true }).click();
          await expect(viewer.getByLabel("Subagent", { exact: true })).toHaveValue("Reviewer");
          await expect(viewer).toContainText("Read-only");
          await expect(viewer.getByLabel("Message composer", { exact: true })).toHaveCount(0);
        }
        expect(pages.some((query) => new URLSearchParams(query).get("cursor") === "native-next")).toBe(true);
        await first.screenshot({ path: `/private/tmp/kodex-native-subagents-${shape.name.replaceAll(" ", "-")}.png` });
        await expect.poll(() => fixture.connected("first") && fixture.connected("second")).toBe(true);
        rows = [scout];
        fixture.subagentsChanged("first");
        const firstViewer = first.getByRole("complementary", { name: "Subagent thread viewer", exact: true });
        const secondViewer = second.getByRole("complementary", { name: "Subagent thread viewer", exact: true });
        await expect(firstViewer).toContainText("Scout");
        await expect(firstViewer.getByLabel("Subagent", { exact: true })).toHaveValue("Scout [explorer]");
        await expect(secondViewer.getByLabel("Subagent", { exact: true })).toHaveValue("Reviewer");
        const connections = fixture.connections.get("second") ?? 0;
        fixture.disconnect("second");
        await expect.poll(() => fixture.connections.get("second") ?? 0).toBeGreaterThan(connections);
        await expect(secondViewer.getByLabel("Subagent", { exact: true })).toHaveValue("Scout [explorer]");
        await expect(secondViewer).toContainText("Scout");
        expect(mutations).toEqual([]);

        // Native denial also applies when the child is opened as a main pane.
        await first.goto("/threads/native-reviewer");
        const pane = first.locator('.kodex-thread-pane[data-workspace-pane-active="true"]');
        await expect(pane).toContainText("This native subagent does not accept direct input.");
        await expect(pane.getByLabel("Message composer", { exact: true })).toHaveCount(0);
        await expect.poll(() => fixture.connected("first")).toBe(true);
        reviewer.canAcceptDirectInput = true;
        fixture.subagentsChanged(undefined, reviewer.id);
        await expect(pane.getByLabel("Message composer", { exact: true })).toBeVisible();
        expect(childReads.filter((id) => id === reviewer.id).length).toBeGreaterThan(1);
        expect(mutations.length).toBeGreaterThan(0);
        expect(mutations.every((request) => request === "POST /v1/threads/native-reviewer/attach")).toBe(true);
      } finally {
        await fixture.close();
      }
      expect(fixture.errors).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    });
  });
}
