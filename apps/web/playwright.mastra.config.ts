import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: 'mastra-chat.spec.ts',
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:5184', trace: 'retain-on-failure', actionTimeout: 15_000 },
  webServer: {
    command: 'VITE_KODEX_BACKEND=mastra VITE_KODEX_PROXY_TARGET=http://127.0.0.1:18789 npm run dev -- --host 127.0.0.1 --port 5184 --strictPort',
    url: 'http://127.0.0.1:5184',
    reuseExistingServer: false,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'narrow-fine', use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 } } },
    { name: 'narrow-touch', use: { ...devices['iPhone 13'], browserName: 'chromium' } },
  ],
});
