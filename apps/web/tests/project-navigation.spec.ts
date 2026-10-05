import { expect, test } from "@playwright/test";
import type { Project, ThreadSummary, ThreadViewResponse } from "../src/api/client";

const projectCwd = "/tmp/kodex-project";
const project: Project = { id: "project-1", name: "Kodex", roots: [{ path: projectCwd }], metadata: {}, position: 0, createdAt: 1791072000, updatedAt: 1791072000, recencyAt: null };
const thread: ThreadSummary = { pinned: false, id: "thread-1", name: "Project chat", projectId: project.id, cwd: projectCwd, status: "idle", rawPayload: {},
  createdAt: 0, updatedAt: 0, parentThreadId: null, canAcceptDirectInput: true, notificationsEnabled: true,
  latestCompletedTurnId: null, seenCompletedTurnId: null, readRevision: 0, readStateKnown: true, unreadCompletedAgentTurn: false };
const detail: ThreadViewResponse = {
  thread, liveState: "idle",
  timeline: { viewRevision: 1, activeTurnId: null, liveState: "idle", pendingApprovalRequests: [], pendingUserInputRequests: [], rows: [], turns: [] },
};

for (const shape of [
  { name: "desktop", width: 1280, hasTouch: false, isMobile: false },
  { name: "narrow fine pointer", width: 390, hasTouch: false, isMobile: false },
  { name: "narrow touch", width: 390, hasTouch: true, isMobile: true },
]) {
  test.describe(shape.name, () => {
    test.use({ viewport: { width: shape.width, height: 844 }, hasTouch: shape.hasTouch, isMobile: shape.isMobile });

    test("keeps project navigation and chat actions after removing remote previews", async ({ page }) => {
      const unexpected: string[] = [];
      const previewRequests: string[] = [];
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
      await page.route("**/v1/**", async (route) => {
        const request = route.request();
        const pathname = new URL(request.url()).pathname;
        const key = `${request.method()} ${pathname}`;
        if (/\/previews|\/preview-services|\/project-previews/.test(pathname)) previewRequests.push(key);
        if (key === "GET /v1/events") {
          await route.fulfill({ contentType: "text/event-stream", body: "" });
          return;
        }
        const routes: Record<string, unknown> = {
          "GET /v1/capabilities": {
            gateway: { instanceId: "project-navigation", version: "test", sse: true, approvals: true, terminals: { enabled: true }, gatewayAuth: false, trustedNetworkOnly: true },
            appServer: { ready: true, experimentalApi: true, schemaVersion: "0.160.0", detectedVersion: "0.160.0", detectedVersionMatchesSchema: true },
          },
          "GET /v1/projects/project-1": project,
          "GET /v1/sidebar/threads": { projects: [project], projectThreads: { [project.id]: { threads: [thread] } }, chatThreads: { threads: [] }, pinnedThreads: { threads: [] } },
          "GET /v1/threads/unread-badge": { count: 0, readRevision: 0 },
          "GET /v1/threads/thread-1": detail,
          "GET /v1/threads/thread-1/settings": { model: "gpt-5.4", effort: "medium", serviceTier: null, activePermissionProfile: null },
          "POST /v1/threads/thread-1/attach": detail,
          "GET /v1/threads/thread-1/app-surface": { session: null },
          "GET /v1/threads/thread-1/queued-inputs": { queuedInputs: [], transfers: [], nextCursor: null },
          "GET /v1/threads/thread-1/subagents": { subagents: [], nextCursor: null },
          "GET /v1/account": { account: null, requiresOpenaiAuth: false, rawPayload: {} },
          "GET /v1/account/rate-limits": { rateLimits: null, rawPayload: {} },
          "GET /v1/approvals": { runtimeId: "project-navigation-runtime", revision: 0, approvals: [] },
          "GET /v1/models": { models: [], rawPayload: {} },
          "GET /v1/composer-settings": {},
          "GET /v1/permission-profiles": { profiles: [] },
          "PUT /v1/thread-view-presence": { ok: true },
        };
        if (!(key in routes)) {
          unexpected.push(key);
          await route.fulfill({ status: 404, json: { code: "not_found", message: key, retryable: false } });
          return;
        }
        await route.fulfill({ json: routes[key] });
      });

      await page.goto("/projects/project-1");
      const main = page.getByRole("main", { name: "Project", exact: true });
      await expect(main.getByRole("heading", { name: "Kodex" })).toBeVisible();
      await expect(main.getByText(projectCwd)).toBeVisible();
      await expect(main.getByRole("button", { name: /add service|add preview|restart proxy/i })).toHaveCount(0);

      if (shape.width < 700) await main.getByRole("button", { name: "Projects", exact: true }).click();
      const workspace = page.getByRole("navigation", { name: "Workspace" });
      const chat = workspace.getByRole("button", { name: "Project chat", exact: true });
      if (shape.hasTouch) await chat.tap();
      else await chat.click();
      await expect(page.getByRole("heading", { name: "Project chat", exact: true })).toBeVisible();

      if (shape.width < 700) await page.getByRole("button", { name: /show sidebar/i }).click();
      if (!shape.hasTouch) await workspace.getByRole("group", { name: "Kodex", exact: true }).hover();
      await workspace.getByRole("button", { name: /new thread|create thread in kodex/i }).click();
      const activePane = page.locator('.kodex-thread-pane[data-workspace-pane-active="true"]');
      await expect(activePane.getByRole("textbox", { name: /message composer/i })).toHaveValue("");
      if (shape.width < 700) await page.getByRole("button", { name: /show sidebar/i }).click();
      await expect(workspace.getByRole("button", { name: "Terminal", exact: true })).toBeVisible();
      await expect(workspace.getByRole("button", { name: "Terminal", exact: true })).toBeEnabled();
      expect(previewRequests).toEqual([]);
      expect(unexpected).toEqual([]);
      expect(errors).toEqual([]);
    });
  });
}
