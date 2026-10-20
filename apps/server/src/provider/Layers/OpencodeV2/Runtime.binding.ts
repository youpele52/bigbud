import { createHash } from "node:crypto";
import {
  v2CompactNativeSessionId,
  V2_NATIVE_SESSION_PATH_LIMIT,
} from "./Orchestration.sessionIdentity.ts";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
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
  // Mode selection cannot erase shared history, including cursor/journal-free create intents.
  const sharedEvidence = options.sharedBindings
    ? await Effect.runPromise(options.sharedBindings.find(input.threadId))
    : undefined;
  if (sharedEvidence && !options.config.sharedService)
    throw new Error(
      "V2 retained shared history cannot be acquired in isolated mode; no replacement.",
    );
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
  if (!input.cwd) throw new Error("V2 requires a native Location workspace.");
  if (!remote && !path.isAbsolute(input.cwd))
    throw new Error("V2 requires an absolute native Location; no process cwd fallback.");
  const root = options.config.sharedService
    ? options.config.sharedService.registrationFile
    : runtimeTarget !== "local"
      ? path.posix.resolve(options.config.profileRoot)
      : await realpath(options.config.profileRoot);
  const directory =
    runtimeTarget !== "local" ? path.posix.resolve(input.cwd) : await realpath(input.cwd);
  if (!remote && !options.config.sharedService)
    await assertV2WorkspaceStorageSeparate(root, directory);
  let storageIdentity =
    options.config.sharedService?.storageIdentity ?? v2StorageIdentity(runtimeTarget, root);
  const profileIssuer = await options.profileIssuer?.();
  if (profileIssuer !== undefined && !/^[a-f0-9]{64}$/.test(profileIssuer))
    throw new Error("V2 profile issuer is invalid.");
  let registrationFamily: "legacy" | "scoped" = profileIssuer ? "scoped" : "legacy";
  const digest = createHash("sha256")
    .update(
      JSON.stringify(
        profileIssuer && options.config.sharedService
          ? ["bigbud.shared-session.v3", storageIdentity, profileIssuer, input.threadId]
          : [storageIdentity, input.threadId],
      ),
    )
    .digest("hex");
  let nativeSessionId =
    profileIssuer && options.config.sharedService
      ? v2CompactNativeSessionId(profileIssuer, digest)
      : `ses_bigbud_${digest}`;
  if (options.config.sharedService) {
    const { retainedSharedIdentity } = await import("./Runtime.binding.shared.ts");
    const retained = await retainedSharedIdentity(options, input, {
      directory,
      runtimeTarget,
      workspaceTarget,
    });
    if (retained) ({ storageIdentity, nativeSessionId, registrationFamily } = retained);
  }
  if (nativeSessionId.length > V2_NATIVE_SESSION_PATH_LIMIT)
    throw new Error(
      "V2 retained native session ID exceeds the native router limit. Existing history and creation evidence remain unchanged; use an explicit new thread. No replacement, deletion or replay is authorized.",
    );
  return {
    runtimeTarget,
    workspaceTarget,
    directory,
    root,
    storageIdentity,
    nativeSessionId,
    registrationFamily,
    profileIssuer,
  };
}
