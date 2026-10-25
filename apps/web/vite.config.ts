import path from "node:path";
import { prepareDesktopViewer } from "./scripts/prepare-desktop-viewer.mjs";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

import { buildKodexColorSchemeBootstrapScript, buildKodexColorSchemeCss } from "./src/themeRegistry";

const gatewayProxyTarget = process.env.VITE_KODEX_PROXY_TARGET ?? "http://127.0.0.1:8787";

const desktopViewer = prepareDesktopViewer();

export default defineConfig({
  define: { __DESKTOP_VIEWER_URL__: JSON.stringify(desktopViewer.url) },
  resolve: { alias: { "@desktop-vendor": desktopViewer.sourceRoot } },
  build: { rollupOptions: { input: { main: path.resolve("index.html"), desktop: desktopViewer.indexPath } } },
  plugins: [
    react(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      injectRegister: false,
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
            src: "/kodex-pwa-192-f5a3d629.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/kodex-pwa-256-cf7e1ed8.png",
            sizes: "256x256",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/kodex-pwa-512-b19511bf.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/kodex-apple-touch-180-17006550.png",
            sizes: "180x180",
            type: "image/png",
            purpose: "any",
          },
        ],
      },
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,ico,png,webmanifest}"],
        globIgnores: ["**/sources/**"],
      },
    }),
    {
      name: "kodex-theme-bootstrap",
      transformIndexHtml(html, context) {
        if (context.path.startsWith("/assets/desktop-viewer/")) return html;
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
      "/v1": {
        target: gatewayProxyTarget,
        ws: true,
      },
      "/openapi.json": gatewayProxyTarget,
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    setupFiles: "./src/test/setup.ts",
    testTimeout: 20000,
  },
});
