import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

const SHARED = resolve(__dirname, "../shared/src");
const SERVER = process.env.SERVER_URL ?? "http://localhost:3000";
const TRACKER = process.env.TRACKER_URL ?? "http://localhost:3001";

export default defineConfig({
  // GitHub Pages serves a project repo from /<repo-name>/, not the domain
  // root — set via PAGES_BASE in the Pages deploy workflow only; local dev
  // and the real appliance server both serve from / and are unaffected.
  base: process.env.PAGES_BASE ?? "/",
  plugins: [react()],
  resolve: {
    alias: { "@shared": SHARED },
  },
  server: {
    host: true, // expose dev server on LAN too
    fs: { allow: [resolve(__dirname, ".."), SHARED] },
    proxy: {
      // tracker first: more specific prefixes win over the bare /api below
      "/api/tracker": { target: TRACKER, changeOrigin: true },
      "/tracker-ws": { target: TRACKER, ws: true, changeOrigin: true },
      "/video": { target: TRACKER, changeOrigin: true },
      "/frame.jpg": { target: TRACKER, changeOrigin: true },
      "/api": { target: SERVER, changeOrigin: true },
      "/ws": { target: SERVER, ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(__dirname, "index.html"),
        control: resolve(__dirname, "control.html"),
        tracker: resolve(__dirname, "tracker.html"),
        tv: resolve(__dirname, "tv.html"),
        stream: resolve(__dirname, "stream.html"),
      },
    },
  },
});
