import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_MOBILE_WEB_PORT } from "@bigbud/shared/DevPorts";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import pkg from "./package.json" with { type: "json" };

const port = Number(process.env.MOBILE_WEB_PORT ?? process.env.PORT ?? DEFAULT_MOBILE_WEB_PORT);
const webSrcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../web/src");

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    "import.meta.env.APP_VERSION": JSON.stringify(pkg.version),
  },
  optimizeDeps: {
    include: ["@pierre/diffs", "@pierre/diffs/react", "@pierre/diffs/worker/worker.js"],
  },
  resolve: {
    alias: {
      "~": webSrcDir,
    },
    tsconfigPaths: true,
  },
  server: {
    host: "0.0.0.0",
    port,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
