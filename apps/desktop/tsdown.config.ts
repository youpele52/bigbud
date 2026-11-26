import { defineConfig } from "tsdown";

const shared = {
  format: "cjs" as const,
  outDir: "dist-electron",
  sourcemap: true,
  outExtensions: () => ({ js: ".js" }),
};

export default defineConfig([
  {
    ...shared,
    entry: ["src/main.ts"],
    clean: true,
    noExternal: (id) => id.startsWith("@bigbud/"),
  },
  {
    ...shared,
    entry: ["src/preload.ts"],
  },
  {
    // Restricted computer-use safety preload; never the broad preload.
    ...shared,
    entry: { "computerUseSafety.preload": "src/computer-use/safetyPreload.ts" },
  },
]);
