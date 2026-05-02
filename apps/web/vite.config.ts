import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

import { buildKodexColorSchemeBootstrapScript, buildKodexColorSchemeCss } from "./src/themeRegistry";

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
      "/v1": "http://127.0.0.1:8787",
      "/openapi.json": "http://127.0.0.1:8787",
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    setupFiles: "./src/test/setup.ts",
  },
});
