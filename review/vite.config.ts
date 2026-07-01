import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The comment rail is served by the Worker at api.snapdoc.carraes.dev/review/:id.
// The shell HTML is server-rendered and references fixed asset names, so this
// build emits app.js / app.css (unhashed) into the Worker's static assets. Local
// iteration mirrors prod: `just review-build` then `wrangler dev`.
export default defineConfig({
  base: "/review/",
  plugins: [react()],
  build: {
    outDir: "../worker/public/review",
    emptyOutDir: true,
    rollupOptions: {
      input: "src/main.tsx",
      output: {
        entryFileNames: "app.js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: (info) => {
          const name = info.name ?? "";
          return name.endsWith(".css") ? "app.css" : "assets/[name]-[hash][extname]";
        },
      },
    },
  },
});
