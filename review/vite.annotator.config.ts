import { defineConfig } from "vite";

// The annotator is injected into the (cross-origin, sandboxed) artifact document,
// so it must load as a self-contained CLASSIC script — a cross-origin ES module
// would need CORS the static host doesn't send. Build it as one fixed-name IIFE,
// appended to (not replacing) the app bundle in the same output dir.
export default defineConfig({
  build: {
    outDir: "../worker/public/review",
    emptyOutDir: false,
    lib: {
      entry: "src/annotator.ts",
      formats: ["iife"],
      name: "SnapdocAnnotator",
      fileName: () => "annotator.js",
    },
  },
});
