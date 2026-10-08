import { defineConfig, devices } from '@playwright/test';

// Run after a VITE_KODEX_BACKEND=mastra production build. The fixture owns HTTP.
export default defineConfig({
  testDir: './tests', testMatch: 'mastra-pwa.spec.ts', workers: 1,
  timeout: 120_000, expect: { timeout: 15_000 }, reporter: 'list',
  // Full bundled Chromium supports worker BadgeService; headless-shell crashes on that API.
  use: { channel: 'chromium', baseURL: 'http://127.0.0.1:18789', trace: 'retain-on-failure', actionTimeout: 15_000 },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'narrow-fine', use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 } } },
    { name: 'narrow-touch', use: { ...devices['iPhone 13'], browserName: 'chromium' } },
  ],
});
