import type { V2ThreadToolsActivation } from "./PluginSetup.activation.ts";
import type { V2ActivationJobScope } from "./PluginSetup.activation.jobs.ts";
import type { V2PluginSetupArtifact } from "./PluginSetup.record.ts";
import type { OpencodeV2Client } from "./Client.ts";
import { verifyV2ThreadTools } from "./Orchestration.readiness.ts";
import { v2ReadinessFailure, type V2ReadinessFailure } from "./Orchestration.readiness.failure.ts";
import { currentV2RequestContext } from "./Client.guard.ts";
import { V2NativeCompatibilityError } from "./NativeCompatibility.types.ts";
import { v2ThreadRegistration } from "./Orchestration.registration.ts";
import { readV2CompatibleManualBootstrap } from "./Orchestration.readiness.manual.ts";
import { readV2RetainedArtifact } from "./Orchestration.artifact.retained.ts";
import { currentV2CallerSignal } from "./Runtime.caller.ts";
import { V2ActivationDeferred } from "./PluginSetup.activation.errors.ts";

/** Verify unchanged native readiness before creating any setup job or observing global activity. */
export async function awaitV2ThreadToolsReady(
  coordinator: V2ThreadToolsActivation,
  artifact: V2PluginSetupArtifact,
  descriptor: V2ActivationJobScope["descriptor"],
  client: OpencodeV2Client,
  directory: string,
  signal?: AbortSignal,
) {
  const owned = coordinator.scopeFor(artifact, descriptor);
  const verify = (candidate: V2PluginSetupArtifact) =>
    verifyV2ThreadTools(
      candidate,
      client,
      directory,
      signal,
      undefined,
      coordinator.nativeEligibility,
      owned.scope.root,
    );
  let failure: V2ReadinessFailure | undefined;
  let verified: Awaited<ReturnType<typeof verifyV2ThreadTools>> | undefined;
  try {
    verified = await verify(artifact);
  } catch (error) {
    signal?.throwIfAborted();
    currentV2RequestContext()?.permit.assertCurrent();
    if (
      error instanceof V2NativeCompatibilityError &&
      error.reasonCode !== "bootstrap-contract-incompatible"
    ) {
      owned.gate.invalidate();
      throw error;
    }
    failure = v2ReadinessFailure(error);
  }
  // A valid loaded plugin cannot repair an application gate scope/capacity/epoch failure.
  // Do not turn such a failure into native publication and global CLI idle waiting.
  if (verified)
    return {
      gate: owned.gate,
      stamp: owned.gate.verify(
        directory,
        verified.bootstrapDigest,
        verified.setupInstanceId,
        verified.nativeProof,
      ),
    };
  if (v2ThreadRegistration(artifact).family === "legacy")
    throw new Error(
      "V2 retained legacy bootstrap is unavailable; history remains read-only. Restore its exact original installation; no cross-family migration or replacement was attempted.",
    );
  const retainedManual = await readV2CompatibleManualBootstrap(
    artifact,
    client,
    directory,
    signal,
    coordinator.nativeEligibility,
    owned.scope.root,
  );
  if (retainedManual) {
    owned.gate.adoptRetained(retainedManual.artifactDigest);
    const info = await verify(retainedManual);
    return {
      gate: owned.gate,
      stamp: owned.gate.verify(
        directory,
        info.bootstrapDigest,
        info.setupInstanceId,
        info.nativeProof,
      ),
    };
  }
  const requested = coordinator.requestSetup(
    artifact,
    descriptor,
    directory,
    currentV2CallerSignal() ?? signal,
    failure,
  );
  const status = await coordinator.jobs.wait(requested.handle, requested.scope, signal);
  if (status.state !== "ready") {
    if (["waiting-for-idle", "deferred"].includes(status.state))
      throw new V2ActivationDeferred(status, requested.handle);
    throw new Error(
      `V2 required thread-tools setup ${status.state}; no prompt/binding was admitted. ${status.reason ?? "Wait for known native work, then retry the normal foreground action."}`,
    );
  }
  const installed = await readV2RetainedArtifact(
    artifact,
    status.installedBootstrapDigest ?? artifact.artifactDigest,
  );
  const info = await verify(installed);
  return {
    gate: owned.gate,
    stamp: owned.gate.verify(
      directory,
      info.bootstrapDigest,
      info.setupInstanceId,
      info.nativeProof,
    ),
  };
}
