import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

import { buildKodexColorSchemeBootstrapScript, buildKodexColorSchemeCss } from "./src/themeRegistry";

const gatewayProxyTarget = process.env.VITE_KODEX_PROXY_TARGET ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      registerType: "prompt",
      manifest: {
        id: "/",
        name: "Kodex",
        short_name: "Kodex",
        description: "Kodex local coding workspace",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#0f1115",
        theme_color: "#0f1115",
        icons: [
          {
            src: "/icon-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any maskable",
          },
          {
            src: "/icon-256.png",
            sizes: "256x256",
            type: "image/png",
            purpose: "any maskable",
          },
          {
            src: "/icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any maskable",
          },
          {
            src: "/apple-touch-icon.png",
            sizes: "180x180",
            type: "image/png",
            purpose: "any",
          },
        ],
      },
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,ico,png,webmanifest}"],
      },
    }),
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
