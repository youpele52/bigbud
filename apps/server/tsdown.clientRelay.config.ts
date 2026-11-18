import { defineConfig, type UserConfig } from "tsdown";

/** One self-contained file per helper: the laptop's sha256 pin of an entry covers all its code. */
const helper = (name: string, entry: string, outDir: string): UserConfig => ({
  entry: { [name]: entry },
  format: ["esm"],
  outDir,
  clean: true,
  noExternal: () => true,
  inlineOnly: false,
  sourcemap: true,
  banner: { js: "#!/usr/bin/env node\n" },
});

/** Separate compilations prevent helper imports from evaluating the server's executable entry. */
export default defineConfig([
  helper(
    "remoteBackendClientRelay",
    "src/remote-backend/clientRelay.entry.ts",
    "dist/remote-client-relay",
  ),
  // `remote-peer-relay`: the P8 worker forced-command helper; reaches only the peer socket.
  helper(
    "remoteBackendPeerRelay",
    "src/remote-backend/peerRelay.entry.ts",
    "dist/remote-peer-relay",
  ),
]);
