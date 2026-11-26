import { defineConfig } from "tsdown";

import { sshOwnerActivationDefine } from "@bigbud/shared/SshOwnerActivation.build";

const shared = {
  format: "cjs" as const,
  outDir: "dist-electron",
  sourcemap: true,
  // Temporary local-only SSH owner override; CI/release bundles get a literal `false`.
  define: sshOwnerActivationDefine(),
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
