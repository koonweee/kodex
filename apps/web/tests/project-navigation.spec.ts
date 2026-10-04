import { expect, test } from "@playwright/test";

const project = { id: "project-1", name: "Kodex", cwd: "/tmp/kodex-project", createdAt: "2026-10-04T00:00:00Z", updatedAt: "2026-10-04T00:00:00Z" };
const thread = { id: "thread-1", name: "Project chat", cwd: project.cwd, status: "idle", rawPayload: {} };
const detail = {
  thread, turns: [], liveState: "idle", rawPayload: {},
  timeline: { viewRevision: 1, activeTurnId: null, liveState: "idle", pendingApprovalRequests: [], pendingUserInputRequests: [], rows: [], items: [], turns: [] },
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
          "GET /v1/threads/thread-1": detail,
          "POST /v1/threads/thread-1/attach": { disposition: "resumed", thread },
          "GET /v1/threads/thread-1/app-surface": { session: null },
          "GET /v1/threads/thread-1/queued-inputs": { queuedInputs: [] },
          "GET /v1/threads/thread-1/subagents": { subagents: [] },
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
      await expect(main.getByText(project.cwd)).toBeVisible();
      await expect(main.getByRole("button", { name: /add service|add preview|restart proxy/i })).toHaveCount(0);

      if (shape.width < 700) await main.getByRole("button", { name: "Projects", exact: true }).click();
      const workspace = page.getByRole("navigation", { name: "Workspace" });
      await workspace.getByRole("button", { name: /project chat/i }).click();
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
