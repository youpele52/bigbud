import {
  makeRemoteAgentComposition,
  type RemoteAgentComposition,
} from "./remoteAgentComposition.ts";
import {
  detectInstalledProxyBinding,
  type VerifiedInstalledProxyObservation,
} from "./remoteAgentComposition.installedAdmission.ts";
import {
  InstalledObservationError,
  observeLocalInstalledSupervisor,
} from "./remoteAgentComposition.installedObservation.ts";
import type { RemoteAgentProxyOwner } from "./remoteAgentConnection.owner.ts";
import {
  refuseInstalledRemoteAgentStartup,
  registerInstalledRemoteAgentStartup,
} from "./remoteAgentDefault.ts";
import type { RemoteAgentRegistry } from "./remoteAgentInstall.registry.ts";
import type { RemoteAgentRuntime } from "./remoteAgentRuntime.ts";

/** Every refusal is typed and never falls back to a bootstrap or legacy SSH. */
export type InstalledStartupRefusalReason =
  | "not-admitted"
  | "lifecycle-unsettled"
  | "observation-required"
  | "identity-mismatch";

/**
 * Trusted startup bindings. The endpoint, pinned runtime and owner come from
 * configuration, never from a project, registry snapshot or renderer input.
 */
export interface InstalledStartupBinding {
  readonly executionTargetId: string;
  readonly runtime: RemoteAgentRuntime;
  readonly expectedEpoch: string;
  readonly owner: RemoteAgentProxyOwner;
  /** Read-only snapshot used only to prove admission; never to discover an endpoint. */
  readonly registry: RemoteAgentRegistry | null;
  readonly maxFrameBytes?: number;
}

export type InstalledStartupComposition =
  | {
      readonly kind: "ready";
      readonly composition: RemoteAgentComposition;
      readonly observation: VerifiedInstalledProxyObservation;
    }
  | { readonly kind: "refused"; readonly reason: InstalledStartupRefusalReason };

/**
 * Normal-startup composition: observe the exact pinned endpoint, project the
 * read-only registry through the admission detector, and only then compose the
 * installed proxy owner. A refusal composes nothing, so no SSH is launched.
 */
export async function composeInstalledRemoteAgentStartup(
  input: InstalledStartupBinding,
): Promise<InstalledStartupComposition> {
  const { executionTargetId, runtime, expectedEpoch, owner, registry } = input;
  let observation: VerifiedInstalledProxyObservation;
  try {
    observation = await observeLocalInstalledSupervisor({
      executionTargetId,
      runtime,
      expectedEpoch,
    });
  } catch (error) {
    const reason =
      error instanceof InstalledObservationError ? error.reason : "observation-required";
    refuseInstalledRemoteAgentStartup(executionTargetId, reason);
    return { kind: "refused", reason };
  }
  const detected = detectInstalledProxyBinding(executionTargetId, registry, observation);
  if (detected.kind === "denied") {
    refuseInstalledRemoteAgentStartup(executionTargetId, detected.reason);
    return { kind: "refused", reason: detected.reason };
  }
  const composition = makeRemoteAgentComposition({
    installedProxy: { executionTargetId, binding: detected.binding, owner },
    ...(input.maxFrameBytes !== undefined ? { maxFrameBytes: input.maxFrameBytes } : {}),
  });
  registerInstalledRemoteAgentStartup(executionTargetId, composition);
  return { kind: "ready", composition, observation };
}
