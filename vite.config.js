import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),

    VitePWA({
      registerType: "prompt",

      includeAssets: [],

      manifest: {
        id: "/",
        name: "PYQ Tracker",
        short_name: "PYPA",
        description:
          "Offline-first Previous Year Questions practice and tracking app.",

        theme_color: "#0B3B73",
        background_color: "#FFFFFF",

        display: "standalone",
        start_url: "/",
        scope: "/",

        icons: [
          {
            src: "/pwa-192x192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/pwa-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/maskable-192x192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "maskable",
          },
          {
            src: "/maskable-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },

      workbox: {
        globPatterns: [
          "**/*.{js,css,html,ico,png,svg,webp,woff2}",
        ],

        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,

        // Prevent large application bundles from being excluded.
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },

      devOptions: {
        enabled: false,
      },
    }),
  ],
});