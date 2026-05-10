import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

import { buildKodexColorSchemeBootstrapScript, buildKodexColorSchemeCss } from "./src/themeRegistry";

const gatewayProxyTarget = process.env.VITE_KODEX_PROXY_TARGET ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [
    react(),
    {
      name: "kodex-theme-bootstrap",
      transformIndexHtml(html) {
        return {
          html,
          tags: [
            {
              tag: "script",
              children: buildKodexColorSchemeBootstrapScript(),
              injectTo: "head-prepend",
            },
            {
              tag: "style",
              attrs: { id: "kodex-theme-registry" },
              children: buildKodexColorSchemeCss(),
              injectTo: "head-prepend",
            },
          ],
        };
      },
    },
  ],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/v1": gatewayProxyTarget,
      "/openapi.json": gatewayProxyTarget,
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    setupFiles: "./src/test/setup.ts",
    testTimeout: 10000,
  },
});
