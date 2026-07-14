import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8"),
);

export default defineConfig({
  // Relative base so the built bundle is portable (servable from any path,
  // and works inside the Tauri desktop shell).
  base: "./",
  // Baked-in app version, used by the update notifier to compare against
  // the latest GitHub release.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [react()],
  resolve: {
    alias: {
      "@sketchor/core": fileURLToPath(
        new URL("../../packages/core/src/index.ts", import.meta.url),
      ),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  // Tauri expects a fixed dist dir relative to src-tauri
  build: {
    outDir: "dist",
    target: "es2022",
  },
});
