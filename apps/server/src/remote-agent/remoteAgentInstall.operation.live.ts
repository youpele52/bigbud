import { Layer, ServiceMap } from "effect";

import { activateRemoteAgentFresh } from "./remoteAgentActivation.ts";
import {
  makeRemoteAgentInstallOperations,
  type RemoteAgentInstallOperations,
  type RemoteAgentStagedBuild,
} from "./remoteAgentInstall.operation.ts";
import { openRemoteAgentControl } from "./remoteAgentControl.ts";
import { retireRemoteAgentBuildsForReplace } from "./remoteAgentInstall.replace.ts";
import { remoteAgentOwners } from "./remoteAgentOwners.ts";
import type { RemoteAgentUpdateCoordinatorShape } from "./remoteAgentUpdate.coordinator.ts";

/** One operation registry per backend, shared by the local CLI socket and agent tools. */
export class RemoteAgentInstallOperationsService extends ServiceMap.Service<
  RemoteAgentInstallOperationsService,
  RemoteAgentInstallOperations
>()("bigbud/remote-agent/RemoteAgentInstallOperations") {}

export function makeLiveRemoteAgentInstallOperations(input: {
  readonly install: (
    executionTargetId: string,
    signal?: AbortSignal,
  ) => Promise<RemoteAgentStagedBuild>;
  readonly updateCoordinator?: RemoteAgentUpdateCoordinatorShape;
  /** Pool fence so local connections stop using a generation before it is retired. */
  readonly beginRetirement?: (target: string, generation: string) => Promise<() => void>;
}): RemoteAgentInstallOperations {
  return makeRemoteAgentInstallOperations({
    stage: (target, signal) => input.install(target, signal),
    activate: async (target, requestId) => {
      const activated = await activateRemoteAgentFresh(target, requestId, input.updateCoordinator);
      return {
        currentVersion: activated.currentVersion,
        currentBuildId: activated.currentBuildId,
        ...(activated.warning ? { warning: activated.warning } : {}),
      };
    },
    retire: async (target) => {
      let referencedBuildIds: (() => Promise<ReadonlySet<string>>) | undefined;
      try {
        const owners = remoteAgentOwners();
        referencedBuildIds = () => owners.referencedBuildIds(target);
      } catch {
        // No durable owner store: predecessor retirement stays deferred.
      }
      return retireRemoteAgentBuildsForReplace({
        target,
        control: await openRemoteAgentControl(target),
        ...(referencedBuildIds ? { referencedBuildIds } : {}),
        ...(input.beginRetirement
          ? {
              beginRetirement: (generation: string) => input.beginRetirement!(target, generation),
            }
          : {}),
      });
    },
  });
}

/** Server composition: one operations service bound to the live installer and pool. */
export function remoteAgentInstallOperationsLayer(input: {
  readonly installer: {
    readonly install: Parameters<typeof makeLiveRemoteAgentInstallOperations>[0]["install"];
  };
  readonly updateCoordinator?: RemoteAgentUpdateCoordinatorShape;
  readonly pool: {
    readonly beginRetirement: (target: string, generation: string) => Promise<() => void>;
  };
}) {
  return Layer.succeed(
    RemoteAgentInstallOperationsService,
    makeLiveRemoteAgentInstallOperations({
      install: input.installer.install,
      ...(input.updateCoordinator ? { updateCoordinator: input.updateCoordinator } : {}),
      beginRetirement: (target, generation) => input.pool.beginRetirement(target, generation),
    }),
  );
}
