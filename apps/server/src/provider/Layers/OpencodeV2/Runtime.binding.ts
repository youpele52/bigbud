import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import type { V2IsolatedRuntimeOptions, V2StartInput } from "./Runtime.types.ts";
import { assertV2WorkspaceStorageSeparate } from "./Runtime.workspaceBoundary.ts";

/** A storage namespace belongs to one runtime target and canonical owned profile. */
export function v2StorageIdentity(runtimeTargetId: string, root: string) {
  return createHash("sha256")
    .update(JSON.stringify([runtimeTargetId, root]))
    .digest("hex");
}

/** Resolve the exact prepared target/storage/Location identity without acquiring or admitting native work. */
export async function resolveV2RuntimeBinding(
  options: V2IsolatedRuntimeOptions,
  input: V2StartInput,
) {
  const runtimeTarget =
    input.providerRuntimeExecutionTargetId ??
    input.executionTargetId ??
    options.config.runtimeTargetId;
  const workspaceTarget =
    input.workspaceExecutionTargetId ?? input.executionTargetId ?? runtimeTarget;
  const remote = runtimeTarget !== "local" || workspaceTarget !== "local";
  const authorization = options.remoteSessionConformance;
  if (
    runtimeTarget !== options.config.runtimeTargetId ||
    (remote &&
      (!authorization ||
        authorization.providerRuntimeTargetId !== runtimeTarget ||
        authorization.workspaceTargetId !== workspaceTarget ||
        authorization.profileRoot !== options.config.profileRoot ||
        authorization.syntheticDirectory !== input.cwd))
  )
    throw new Error("V2 remote runtime/workspace is not verified.");
  if (!input.cwd) throw new Error("V2 requires an isolated workspace.");
  const root =
    runtimeTarget !== "local"
      ? path.posix.resolve(options.config.profileRoot)
      : await realpath(options.config.profileRoot);
  const directory =
    runtimeTarget !== "local" ? path.posix.resolve(input.cwd) : await realpath(input.cwd);
  if (!remote && !options.config.sharedService)
    await assertV2WorkspaceStorageSeparate(root, directory);
  const storageIdentity =
    options.config.sharedService?.storageIdentity ?? v2StorageIdentity(runtimeTarget, root);
  const nativeSessionId = `ses_bigbud_${createHash("sha256")
    .update(JSON.stringify([storageIdentity, input.threadId]))
    .digest("hex")}`;
  return { runtimeTarget, workspaceTarget, directory, root, storageIdentity, nativeSessionId };
}
