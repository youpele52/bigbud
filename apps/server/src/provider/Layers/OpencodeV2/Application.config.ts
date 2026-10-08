import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { inspectPrivateV2Profile } from "./ProfileIsolation.mjs";
import { runWithAbortableDeadline } from "../../RequestDeadline.ts";
import type { V2DevelopmentConfig } from "./Development.config.ts";
import { assertV2ProfileStorageLocation } from "./Runtime.workspaceBoundary.ts";

/** Only a newly created or explicitly bigbud-owned profile may be used by the application. */
export async function readV2ApplicationConfig(input: {
  binaryPath: string;
  profileRoot: string;
}): Promise<V2DevelopmentConfig> {
  if (![input.binaryPath, input.profileRoot].every((value) => path.isAbsolute(value)))
    throw new Error(
      "V2 requires absolute binary and dedicated profile paths in Providers settings.",
    );
  return runWithAbortableDeadline({
    operation: "V2 application profile validation",
    timeoutMs: 5000,
    run: async (signal) => {
      await assertV2ProfileStorageLocation(input.profileRoot);
      signal.throwIfAborted();
      // Never adopt an existing unmarked directory, chmod it, or copy another provider's data.
      try {
        await mkdir(input.profileRoot, { mode: 0o700 });
        await inspectPrivateV2Profile(input.profileRoot, { signal, marker: false });
        signal.throwIfAborted();
        await writeFile(
          path.join(input.profileRoot, ".bigbud-opencode-v2"),
          "bigbud-opencode-v2-owned-v1\n",
          { flag: "wx", mode: 0o600 },
        );
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      }
      await inspectPrivateV2Profile(input.profileRoot, { signal, application: true });
      const workspace = path.join(input.profileRoot, "catalog");
      await mkdir(workspace, { recursive: true, mode: 0o700 });
      signal.throwIfAborted();
      return { process: { ...input, runtimeTargetId: "local" }, workspace };
    },
  });
}
