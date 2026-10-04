import { expect, test, type Locator, type Page } from "@playwright/test";

import { nativeMcpAuthFixture } from "./native-mcp-auth.fixture";

for (const shape of [
  { name: "desktop", width: 1280, hasTouch: false, isMobile: false },
  { name: "narrow fine pointer", width: 390, hasTouch: false, isMobile: false },
  { name: "narrow touch", width: 390, hasTouch: true, isMobile: true },
]) {
  test.describe(shape.name, () => {
    test.use({ viewport: { width: shape.width, height: 844 }, hasTouch: shape.hasTouch, isMobile: shape.isMobile });
    test("MCP login attempts stay local while native config and auth converge across tabs", async ({ context }) => {
      const fixture = await nativeMcpAuthFixture(context);
      const touch = shape.hasTouch;
      try {
        const first = await fixture.page("first");
        const second = await fixture.page("second");
        for (const page of [first, second]) {
          await openMcp(page, touch);
          await selectServer(page, "proof.with.dot", touch);
        }
        await expect.poll(() => fixture.connected("first") && fixture.connected("second")).toBe(true);
        const connections = new Map(fixture.connections);

        // Sparse writes must retain fields the form never loaded, including
        // policy keys and masked credentials, and converge via the native read.
        const target = fixture.writeTarget();
        await click(first.getByRole("button", { name: "Edit", exact: true }), touch);
        const form = first.getByRole("dialog", { name: "Edit MCP server", exact: true });
        await form.getByLabel("URL", { exact: true }).fill("https://auth-config.example/mcp");
        await click(form.getByRole("button", { name: "Save changes", exact: true }), touch);
        await expect(form).toHaveCount(0);
        await expectMcpUrl(second, "https://auth-config.example/mcp", touch);
        expect(fixture.requests.filter(({ key }) => key === "PATCH /v1/mcp/servers/proof.with.dot").map(({ body }) => body)).toEqual([
          { writeTarget: target, edits: [{ keyPath: ["url"], value: "https://auth-config.example/mcp" }] },
        ]);
        expect(fixture.native.future_policy).toEqual({ approval: "required", allow: ["protected-tool"] });
        expect(fixture.native.disabled_tools).toEqual(["protected-tool"]);
        expect(fixture.native.http_headers).toEqual({ Authorization: "fixture-private-secret", "X.Proof.Key": "private-header" });

        // A late response cannot attach its URL to a different selected server.
        fixture.holdNext("first", "login", "old-server");
        await click(first.getByRole("button", { name: "Log in", exact: true }), touch);
        await expect.poll(() => fixture.isHeld("old-server")).toBe(true);
        await selectServer(first, "other-account", touch);
        await fixture.release("old-server");
        await expect(first.getByRole("link", { name: "Open login", exact: true })).toHaveCount(0);
        await selectServer(first, "proof.with.dot", touch);
        await expect(first.getByRole("link", { name: "Open login", exact: true })).toHaveCount(0);

        // Reselecting the same server retires its attempt without claiming to
        // cancel the native listener. Its eventual URL must not replace retry.
        fixture.holdNext("first", "login", "old-attempt");
        await click(first.getByRole("button", { name: "Log in", exact: true }), touch);
        await expect.poll(() => fixture.isHeld("old-attempt")).toBe(true);
        await selectServer(first, "proof.with.dot", touch);
        await click(first.getByRole("button", { name: "Log in", exact: true }), touch);
        const login = first.getByRole("link", { name: "Open login", exact: true });
        await expect(login).toHaveAttribute("href", "https://auth.example.test/proof.with.dot/attempt-3");
        await fixture.release("old-attempt");
        await expect(login).toHaveAttribute("href", "https://auth.example.test/proof.with.dot/attempt-3");
        await expect(second.getByRole("link", { name: "Open login", exact: true })).toHaveCount(0);
        expect(fixture.authRequests.filter(({ key }) => key.endsWith("/oauth-login")).map(({ client, body }) => ({ client, body }))).toEqual([
          { client: "first", body: {} }, { client: "first", body: {} }, { client: "first", body: {} },
        ]);

        // Hold an old logged-out read before a completion. Both open streams
        // must refill from native status, canceling the captured stale response.
        fixture.holdNext("second", "inventory", "old-inventory");
        await second.evaluate(() => window.dispatchEvent(new Event("focus")));
        await expect.poll(() => fixture.isHeld("old-inventory")).toBe(true);
        fixture.setAuthorized("proof.with.dot", true);
        fixture.complete("proof.with.dot", true);
        for (const page of [first, second]) await expect(serverRow(page, "proof.with.dot")).toContainText("Connected");
        await expect.poll(() => fixture.wasAborted("old-inventory")).toBe(true);
        await fixture.release("old-inventory");
        for (const page of [first, second]) {
          await expect(serverRow(page, "proof.with.dot")).toContainText("OAuth");
          await expect(page.getByText("lookup", { exact: true })).toBeVisible();
          await expect(page.locator("body")).not.toContainText("fixture-private-secret");
        }
        expect(fixture.connections).toEqual(connections);
        await first.screenshot({ path: test.info().outputPath("mcp-authenticated.png") });

        // Model an independently expired native credential. A failed attempt's
        // notification is only an invalidation, not the source of auth state.
        // The second tab misses it, so an actual reopen must refill inventory.
        fixture.setAuthorized("proof.with.dot", false);
        fixture.complete("proof.with.dot", false, "first");
        await expect(serverRow(first, "proof.with.dot")).toContainText("Authentication required");
        await expect(serverRow(second, "proof.with.dot")).toContainText("Connected");
        const oldConnections = fixture.connections.get("second") ?? 0;
        fixture.disconnect("second");
        await expect.poll(() => fixture.connections.get("second") ?? 0).toBeGreaterThan(oldConnections);
        await expect(serverRow(second, "proof.with.dot")).toContainText("Authentication required");
        await expect(second.getByText("lookup", { exact: true })).toHaveCount(0);
        await expect(second.getByRole("link", { name: "Open login", exact: true })).toHaveCount(0);
      } finally { await fixture.close(); }
      expect(fixture.unexpected).toEqual([]);
      expect(fixture.errors).toEqual([]);
    });
  });
}

async function click(locator: Locator, touch: boolean) { if (touch) await locator.tap(); else await locator.click(); }
function serverRow(page: Page, name: string) { return page.getByRole("button", { name: new RegExp(`^${name.replaceAll(".", "\\.")} `) }); }
async function selectServer(page: Page, name: string, touch: boolean) { await click(serverRow(page, name), touch); }
async function openMcp(page: Page, touch: boolean) {
  const sidebar = page.getByRole("navigation", { name: "Workspace", exact: true });
  if (!await sidebar.isVisible()) await click(page.getByRole("button", { name: /^(Show sidebar|Projects)$/i }), touch);
  await click(sidebar.getByRole("button", { name: "Account settings", exact: true }), touch);
  await click(page.getByRole("menuitem", { name: "Preferences", exact: true }), touch);
  await expect(page.getByRole("dialog", { name: "Preferences", exact: true })).toBeVisible();
  await click(page.getByRole("button", { name: "MCP", exact: true }), touch);
}
async function expectMcpUrl(page: Page, value: string, touch: boolean) {
  await click(page.getByRole("button", { name: "Edit", exact: true }), touch);
  const form = page.getByRole("dialog", { name: "Edit MCP server", exact: true });
  await expect(form.getByLabel("URL", { exact: true })).toHaveValue(value);
  await click(form.getByRole("button", { name: "Cancel", exact: true }), touch);
}
