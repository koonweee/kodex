import { expect, test, type Page } from "@playwright/test";
import { nativeSettingsFixture } from "./native-settings.fixture";

for (const { width, hasTouch } of [{ width: 1280, hasTouch: false }, { width: 390, hasTouch: false }, { width: 390, hasTouch: true }]) {
  test.describe(`viewport ${width}, touch ${hasTouch}`, () => {
    test.use({ hasTouch, viewport: { width, height: 900 } });

    async function showSidebar(page: Page) {
      const collapse = page.getByRole("button", { name: "Collapse composer", exact: true });
      if (await collapse.isVisible()) await collapse.click();
      if (width < 900) await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
    }

    async function fixtureWithProjects(context: Parameters<typeof nativeSettingsFixture>[0]) {
      const fixture = await nativeSettingsFixture(context);
      const projects = ["Alpha", "Beta"].map((name, i) => ({ id: `project-${i}`, name, roots: [{ path: `/projects/${name}` }], metadata: {}, position: i, createdAt: 0, updatedAt: 0, recencyAt: null }));
      await context.route("**/v1/projects", (route) => route.fulfill({ json: { projects } }));
      await context.route(/\/v1\/sidebar\/threads(?:\?.*)?$/, (route) => route.fulfill({ json: { projects, projectThreads: {}, chatThreads: { threads: [fixture.detail.thread] }, pinnedThreads: { threads: [] } } }));
      await context.route(/\/v1\/threads(?:\?.*)?$/, (route) => route.fulfill({ json: { threads: new URL(route.request().url()).searchParams.has("projectId") ? [] : [fixture.detail.thread], nextCursor: null } }));
      return fixture;
    }

    test("keeps an existing composer inset when a neighboring draft becomes active", async ({ context }) => {
      test.skip(width < 900, "Neighboring panes are simultaneously visible in the desktop workspace");
      const fixture = await fixtureWithProjects(context);
      try {
        const page = await fixture.page("draft-layout", "/threads/settings-chat");
        const existing = page.locator(".kodex-thread-pane-existing");
        const composer = existing.locator(".kodex-composer-shell");
        await expect(composer).toBeVisible();
        const bottomInset = () => composer.evaluate(el => {
          const pane = el.closest(".kodex-workspace-pane-host")!;
          return Math.min(pane.getBoundingClientRect().bottom, window.innerHeight) - el.getBoundingClientRect().bottom;
        });
        await expect(composer).toHaveAttribute("data-entry-ready", "true");
        const initialInset = await bottomInset();
        expect(initialInset).toBeGreaterThan(0);
        await page.getByRole("navigation", { name: "Workspace", exact: true }).getByRole("button", { name: "Projects", exact: true }).click();
        await page.getByRole("button", { name: "Create thread in Alpha", exact: true }).click();
        const draft = page.locator('.kodex-thread-pane-empty[data-workspace-pane-active="true"]');
        await expect(draft).toBeVisible();
        await expect.poll(bottomInset).toBeCloseTo(initialInset, 0);
        await expect(existing.getByRole("button", { name: "Send message", exact: true })).toBeInViewport();
        const draftComposer = draft.locator(".kodex-composer-shell");
        const draftBounds = await draftComposer.boundingBox();
        const paneBounds = await draft.boundingBox();
        expect(draftBounds!.y).toBeGreaterThan(paneBounds!.y);
        expect(draftBounds!.y + draftBounds!.height).toBeLessThan(paneBounds!.y + paneBounds!.height);
        await page.screenshot({ path: test.info().outputPath("neighboring-draft-composers.png"), animations: "disabled" });
        await page.setViewportSize({ width, height: 650 });
        await expect.poll(bottomInset).toBeCloseTo(initialInset, 0);
        await page.getByTestId("dockview-dv-default-tab").filter({ hasText: "Native settings chat" }).click();
        await expect(existing).toHaveAttribute("data-workspace-pane-active", "true");
        await expect.poll(bottomInset).toBeCloseTo(initialInset, 0);
      } finally { await fixture.close(); }
      expect(fixture.errors).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    });

    test("reuses an empty draft across projects, then replaces it with an existing chat", async ({ context }) => {
      const fixture = await fixtureWithProjects(context);
      try {
        const page = await fixture.page("empty-drafts", "/");
        for (const name of ["Alpha", "Beta", "Alpha"]) {
          await showSidebar(page);
          await page.getByRole("button", { name: `Create thread in ${name}`, exact: true }).click();
          await expect(page.locator(".kodex-thread-pane")).toHaveCount(1);
          await expect(page.getByRole("button", { name: `Project: ${name}`, exact: true })).toContainText(name);
        }
        const composer = page.getByRole("textbox", { name: /message composer/i });
        await composer.fill("Temporary text");
        await composer.fill("");
        await showSidebar(page);
        await page.getByRole("button", { name: "Chats", exact: true }).click();
        await page.getByRole("button", { name: "Native settings chat", exact: true }).click();
        await expect(page.locator(".kodex-thread-pane-existing")).toHaveCount(1);
        await expect(page.locator(".kodex-thread-pane-empty")).toHaveCount(0);
        await expect(page.locator(".kodex-thread-pane")).toHaveCount(1);
      } finally { await fixture.close(); }
      expect(fixture.errors).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    });

    test("preserves a composed draft's project and attachment while reusing another empty draft", async ({ context }) => {
      const fixture = await fixtureWithProjects(context);
      try {
        const page = await fixture.page("composed-drafts", "/");
        await showSidebar(page);
        await page.getByRole("button", { name: "Create thread in Alpha", exact: true }).click();
        const originalDraft = page.locator(".kodex-thread-pane-empty").first();
        const originalComposer = originalDraft.getByRole("textbox", { name: /message composer/i, includeHidden: true });
        await originalComposer.fill("Keep this draft");
        await originalDraft.locator('input[type="file"]').setInputFiles({ name: "draft.txt", mimeType: "text/plain", buffer: Buffer.from("Keep attachment") });
        for (const name of ["Beta", "Alpha"]) {
          await showSidebar(page);
          await page.getByRole("button", { name: `Create thread in ${name}`, exact: true }).click();
          await expect(page.locator(".kodex-thread-pane-empty")).toHaveCount(2);
          await expect(originalComposer).toHaveValue("Keep this draft");
          await expect(originalDraft.getByRole("button", { name: "Project: Alpha", exact: true, includeHidden: true })).toContainText("Alpha");
          await expect(originalDraft.getByText("draft.txt", { exact: true })).toHaveCount(1);
          const emptyComposer = page.locator(".kodex-thread-pane-empty").nth(1).getByRole("textbox", { name: /message composer/i });
          await expect(emptyComposer).toHaveValue("");
          await expect(emptyComposer).toBeVisible();
        }
        if (width < 900) {
          await page.getByRole("button", { name: "Switch workspace pane", exact: true }).click();
          await page.getByRole("dialog", { name: "Active panes", exact: true }).getByRole("button", { name: "New thread", exact: true }).last().click();
        } else {
          await page.getByTestId("dockview-dv-default-tab").filter({ hasText: /^New thread$/ }).first().click();
        }
        await expect(originalComposer).toBeVisible();
        await expect(originalComposer).toHaveValue("Keep this draft");
        await expect(originalDraft.getByText("draft.txt", { exact: true })).toBeVisible();
      } finally { await fixture.close(); }
      expect(fixture.errors).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    });

    test("opening an existing chat preserves an attachment-only draft", async ({ context }) => {
      const fixture = await fixtureWithProjects(context);
      try {
        const page = await fixture.page("attached-drafts", "/");
        const draft = page.locator(".kodex-thread-pane-empty");
        await draft.locator('input[type="file"]').setInputFiles({ name: "draft.txt", mimeType: "text/plain", buffer: Buffer.from("Keep attachment") });
        await showSidebar(page);
        await page.getByRole("button", { name: "Chats", exact: true }).click();
        await page.getByRole("button", { name: "Native settings chat", exact: true }).click();
        await expect(page.locator(".kodex-thread-pane-existing")).toHaveCount(1);
        await expect(page.locator(".kodex-thread-pane-empty")).toHaveCount(1);
        await expect(draft.getByText("draft.txt", { exact: true })).toHaveCount(1);
      } finally { await fixture.close(); }
      expect(fixture.errors).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    });
  });
}
