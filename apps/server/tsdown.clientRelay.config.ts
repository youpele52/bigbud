import { defineConfig } from "tsdown";

/** A separate compilation prevents helper imports from evaluating the server's executable entry. */
export default defineConfig({
  entry: { remoteBackendClientRelay: "src/remote-backend/clientRelay.entry.ts" },
  format: ["esm"],
  outDir: "dist/remote-client-relay",
  clean: true,
  noExternal: () => true,
  inlineOnly: false,
  sourcemap: true,
  banner: { js: "#!/usr/bin/env node\n" },
});
