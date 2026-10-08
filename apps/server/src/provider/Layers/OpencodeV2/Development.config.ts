import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { inspectPrivateV2Profile } from "./ProfileIsolation.mjs";
import { runWithAbortableDeadline } from "../../RequestDeadline.ts";
import type { V2ProcessConfig } from "./ServerManager.child.ts";
import { assertV2WorkspaceStorageSeparate } from "./Runtime.workspaceBoundary.ts";

export const V2_DEVELOPMENT_MARKER = ".bigbud-opencode-v2-development";
export interface V2DevelopmentConfig {
  readonly process: V2ProcessConfig;
  readonly workspace: string;
}

/** Explicit disposable ownership only. No PATH/profile/credential discovery or default roots. */
export async function readV2DevelopmentConfig(
  environment: NodeJS.ProcessEnv,
): Promise<V2DevelopmentConfig> {
  return runWithAbortableDeadline({
    operation: "V2 development profile validation",
    timeoutMs: 5000,
    run: (signal) => inspectDevelopmentConfig(environment, signal),
  });
}

async function inspectDevelopmentConfig(
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<V2DevelopmentConfig> {
  const binaryPath = environment.BIGBUD_OPENCODE_V2_BINARY;
  const root = environment.BIGBUD_OPENCODE_V2_PROFILE_ROOT;
  const workspace = environment.BIGBUD_OPENCODE_V2_WORKSPACE;
  if (
    !binaryPath ||
    !root ||
    !workspace ||
    ![binaryPath, root, workspace].every((value) => path.isAbsolute(value))
  )
    throw new Error(
      "V2 development requires explicit absolute binary, profile root and isolated workspace configuration.",
    );
  const profileRoot = await realpath(root);
  const directory = await realpath(workspace);
  if (
    profileRoot !== path.resolve(root) ||
    profileRoot === path.parse(profileRoot).root ||
    profileRoot === (await realpath(os.homedir()))
  )
    throw new Error("V2 development requires a dedicated canonical profile.");
  if (!(await stat(directory)).isDirectory())
    throw new Error("V2 development workspace is not a directory.");
  await assertV2WorkspaceStorageSeparate(profileRoot, directory);
  await inspectPrivateV2Profile(profileRoot, { signal });
  signal.throwIfAborted();
  return { process: { binaryPath, profileRoot, runtimeTargetId: "local" }, workspace: directory };
}
