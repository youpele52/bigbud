import type { RemoteAgentRuntimeBinding } from "../remote-agent/remoteAgentConnectionPool.ts";
import type { RemoteAgentRegistry } from "../remote-agent/remoteAgentInstall.registry.ts";
import { readyRemoteAgentStableSelection } from "../remote-agent/remoteAgentAdmission.selection.ts";
import {
  remoteAgentRuntimeEqual,
  validateRemoteAgentRuntime,
} from "../remote-agent/remoteAgentRuntime.ts";
import type { LocalSupervisorServiceConfig } from "./localSupervisorService.config.ts";

/** Canonical P4/SQL agreement is required; this function does not mint channel provenance. */
export function managedLeaseRuntimeSelection(
  registry: RemoteAgentRegistry,
  binding: RemoteAgentRuntimeBinding | undefined,
  config: LocalSupervisorServiceConfig,
): RemoteAgentRuntimeBinding {
  const selected = readyRemoteAgentStableSelection(registry, registry.current);
  const build = registry.builds.find((value) => value.id === selected?.buildId);
  if (
    !binding ||
    !selected ||
    !build ||
    !registry.currentConnectionId ||
    binding.connectionId !== registry.currentConnectionId ||
    binding.expectedEpoch !== selected.epoch ||
    !remoteAgentRuntimeEqual(build.runtime, binding.runtime) ||
    registry.retirementReservations.some(
      (value) => value.buildId === selected.buildId && value.phase !== "failed",
    )
  )
    throw Error(
      "Managed lease acquisition requires the current canonical signed P4/SQL admission.",
    );
  const runtime = validateRemoteAgentRuntime(binding.runtime);
  if (
    runtime.origin !== "managed" ||
    config.rust_binary !== runtime.binaryPath ||
    config.rust_sha256 !== runtime.sha256 ||
    config.rust_state !== runtime.statePath
  )
    throw Error("Managed lease service config differs from the admitted immutable runtime.");
  return Object.freeze({
    connectionId: registry.currentConnectionId,
    expectedEpoch: selected.epoch,
    runtime: Object.freeze({ ...runtime }),
  });
}
