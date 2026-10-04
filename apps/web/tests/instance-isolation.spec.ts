import { expect, test } from "@playwright/test";

import type { Capabilities } from "../src/api/client";

const capabilities: Capabilities = {
  gateway: {
    instanceId: "browser-isolation-fixture",
    version: "test",
    sse: true,
    approvals: true,
    terminals: { enabled: true },
    gatewayAuth: false,
    trustedNetworkOnly: true,
  },
  appServer: { ready: true, experimentalApi: true, schemaVersion: "0.160.0", detectedVersion: "0.160.0", detectedVersionMatchesSchema: true },
};

for (const kind of ["threads", "projects"]) {
  test(`keeps an unverified first-visit ${kind} link out of the workspace and preserves retry`, async ({ page }) => {
    const path = `/${kind}/foreign-reference`;
    const requested: string[] = [];
    const pageErrors: string[] = [];
    let referenceReads = 0;
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.route("**/v1/**", async (route) => {
      const url = new URL(route.request().url());
      requested.push(url.pathname);
      if (url.pathname === "/v1/capabilities") {
        await route.fulfill({ json: capabilities });
      } else if (url.pathname === `/v1${path}`) {
        referenceReads += 1;
        await route.fulfill({ status: 502, json: { code: "bad_gateway", message: "Native reference unavailable", retryable: false } });
      } else {
        await route.fulfill({ status: 500, json: { message: "Unexpected workspace request" } });
      }
    });

    await page.goto(path);
    await expect(page.getByRole("alert")).toHaveText("This link could not be opened in this Kodex instance.");
    await expect(page.getByRole("navigation", { name: "Workspace" })).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    const readsBeforeRetry = referenceReads;
    await page.getByRole("button", { name: "Retry" }).click();
    await expect.poll(() => referenceReads).toBeGreaterThan(readsBeforeRetry);
    await expect(page.getByRole("alert")).toHaveText("This link could not be opened in this Kodex instance.");
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    expect(requested.every((url) => url === "/v1/capabilities" || url === `/v1${path}`)).toBe(true);
    expect(pageErrors).toEqual([]);
  });
}
