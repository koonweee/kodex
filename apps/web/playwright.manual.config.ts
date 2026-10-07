import { defineConfig } from "@playwright/test";

import config from "./playwright.config";

// The real provider proof launches installed Chrome; routine suites use Chromium.
export default defineConfig({
  ...config,
  testMatch: "**/native-pwa-provider.manual.ts",
  fullyParallel: false,
  workers: 1,
  webServer: undefined,
});
