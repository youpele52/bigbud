import type { RemoteAgentArtifact } from "./remoteAgentArtifact.ts";
import type { RemoteAgentRuntime } from "./remoteAgentRuntime.ts";
import type { RemoteAgentControl } from "./remoteAgentControl.ts";
import type { RemoteAgentRegistry } from "./remoteAgentInstall.registry.ts";
import { emptyRemoteAgentRegistry } from "./remoteAgentInstall.registry.ts";
import { RemoteAgentCapacityUnavailableError } from "./remoteAgentInstall.stage.ts";
import type { RemoteAgentInstallSourceLoader } from "./remoteAgentInstallSource.ts";
import type { RemoteAgentUpdateCoordinatorDependencies } from "./remoteAgentUpdate.coordinator.ts";
import type { RemoteAgentAdmissionPreparation } from "./remoteAgentUpdate.admission.types.ts";
import {
  readyRemoteAgentSelection,
  readyRemoteAgentStableSelection,
} from "./remoteAgentAdmission.selection.ts";
import {
  isDefinitiveRemoteAgentUpdateFailure,
  prepareRemoteAgentCandidate,
} from "./remoteAgentUpdate.prepare.ts";
import {
  markUpdateFailure,
  bestEffortFailedCandidateCleanup,
} from "./remoteAgentUpdate.failure.ts";

function compareVersions(left: string, right: string): number {
  const a = left.match(/\d+/g)?.map(Number) ?? [];
  const b = right.match(/\d+/g)?.map(Number) ?? [];
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.localeCompare(right);
}

function sameArtifactIdentity(
  runtime: Pick<RemoteAgentRuntime, "version" | "sha256" | "buildDigest" | "targetTriple">,
  artifact: RemoteAgentArtifact,
): boolean {
  return (
    runtime.version === artifact.version &&
    runtime.sha256 === artifact.sha256 &&
    runtime.buildDigest === artifact.buildDigest &&
    runtime.targetTriple === artifact.targetTriple
  );
}

/** Caller owns the preparation queue; all failure bookkeeping completes before it is released. */
export function makeRemoteAgentDiscovery(input: {
  readonly manager: NonNullable<RemoteAgentUpdateCoordinatorDependencies["installManager"]>;
  readonly loadSource: RemoteAgentInstallSourceLoader;
  readonly connect?: RemoteAgentUpdateCoordinatorDependencies["connect"];
  readonly onState: (
    target: string,
    control: RemoteAgentControl,
    state: RemoteAgentRegistry,
  ) => void;
}) {
  return async (
    target: string,
    control: RemoteAgentControl,
    options: {
      readonly refreshSource: boolean;
      readonly forceRetry: boolean;
      readonly onResolved?: (result: RemoteAgentAdmissionPreparation) => void;
    },
  ): Promise<RemoteAgentAdmissionPreparation> => {
    let artifact: RemoteAgentArtifact | undefined;
    let requestId: string | undefined;
    let buildId: string | undefined;
    try {
      const source = await (options.refreshSource
        ? input.loadSource.refresh()
        : input.loadSource());
      const resolved = await input.manager.resolveArtifact({
        executionTargetId: target,
        source,
        verifySignature: true,
      });
      artifact = resolved.artifact;
      const state = await control.registry.read();
      input.onState(target, control, state);
      const current = state.builds.find((build) => build.id === state.current);
      const pending = state.builds.find((build) => build.id === state.pending);
      const newer = [pending, current]
        .filter(
          (build) =>
            build &&
            build.authenticated &&
            compareVersions(artifact!.version, build.runtime.version) < 0 &&
            (build.id === state.current
              ? readyRemoteAgentStableSelection(state, build.id)
              : readyRemoteAgentSelection(state, build.id)),
        )
        .toSorted((left, right) =>
          compareVersions(right!.runtime.version, left!.runtime.version),
        )[0];
      if (newer) return { requestedBuildId: newer.id, requestedVersion: newer.runtime.version };
      requestId = `update-${artifact.sha256}`;
      buildId = `${artifact.version}:${artifact.sha256}:${artifact.targetTriple}`;
      const result = { requestedBuildId: buildId, requestedVersion: artifact.version };
      options.onResolved?.(result);
      if (
        current &&
        current.authenticated &&
        current.health === "healthy" &&
        readyRemoteAgentSelection(state, current.id) &&
        sameArtifactIdentity(current.runtime, artifact)
      )
        return result;
      const update = state.updates.find((entry) => entry.requestId === requestId);
      const failedIdentityMatches = update?.identity
        ? sameArtifactIdentity(update.identity, artifact)
        : update?.buildId === buildId;
      if (update?.phase === "failed" && failedIdentityMatches && !options.forceRetry) return result;
      await prepareRemoteAgentCandidate({
        target,
        requestId,
        artifact,
        source,
        control,
        install: (installInput) => input.manager.install(installInput),
        ...(input.connect ? { connect: input.connect } : {}),
      });
      input.onState(target, control, await control.registry.read());
      return result;
    } catch (cause) {
      if (cause instanceof RemoteAgentCapacityUnavailableError) {
        input.onState(
          target,
          control,
          await control.registry.read().catch(() => emptyRemoteAgentRegistry()),
        );
        throw cause;
      }
      if (!artifact || !requestId || !buildId) throw cause;
      await control.registry
        .update((state) => markUpdateFailure(state, requestId!, buildId!, artifact!, cause))
        .catch(() => undefined);
      input.onState(
        target,
        control,
        await control.registry.read().catch(() => emptyRemoteAgentRegistry()),
      );
      if (isDefinitiveRemoteAgentUpdateFailure(cause))
        await bestEffortFailedCandidateCleanup(target, control, input.manager, buildId).catch(
          () => undefined,
        );
      throw cause;
    }
  };
}
