import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The SPA is served by the Worker at api.snapdoc.carraes.dev/admin, so assets
// resolve under /admin/. Build output lands in the Worker's static-assets dir.
// In dev, Vite proxies the JSON API to a local `wrangler dev`.
export default defineConfig({
  base: "/admin/",
  plugins: [react()],
  build: {
    outDir: "../worker/public/admin",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/v1": "http://localhost:8787",
    },
  },
});
