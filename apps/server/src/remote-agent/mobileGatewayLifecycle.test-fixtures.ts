import { publicationFixture } from "./mobileOptionalPublication.test-fixtures.ts";
import * as Effect from "effect/Effect";
import { BackendInstance } from "../startup/backendInstance.ts";
import { RemoteAgentRuntimeOwners } from "../persistence/Layers/RemoteAgentRuntimeBindings.service.ts";
import type { RemoteAgentOwnerStore } from "./remoteAgentOwners.ts";
import { remoteAgentBuildId } from "./remoteAgentRuntime.ts";
import { makeMobileGatewayLifecycle } from "./mobileGatewayLifecycle.ts";
import type { VerifiedMobilePublication } from "./mobileOptionalPublication.ts";
import type { MobileGatewayAdmissionContext } from "./mobileGatewayLifecycle.transitions.ts";

export const gatewayConfiguration = { externalOrigin: "https://fixture.example", port: 49322 };
export function gatewayContext(
  f: Awaited<ReturnType<typeof publicationFixture>>,
): MobileGatewayAdmissionContext {
  const state = f.read();
  if (state.schemaVersion !== 3) throw new Error("fixture mobile state absent");
  const stage = state.mobile.stages[0]!,
    build = state.builds.find((b) => b.id === state.current)!;
  return {
    owner: state.mobile.owner,
    controller: stage.controller,
    controllerHost: { hostname: f.owner().hostname, machineId: f.owner().machineId },
    stageId: stage.id,
    releaseId: stage.releaseId,
    consentRevision: stage.consentRevision,
    binding: {
      buildId: remoteAgentBuildId(build.runtime),
      generation: build.runtime.generation,
      epoch: state.launches[0]!.epoch!,
      connectionId: state.currentConnectionId ?? build.runtime.generation,
    },
    configuration: gatewayConfiguration,
    now: 100_000,
  };
}
export function gatewayFixtureOwnerStore(
  f: Awaited<ReturnType<typeof publicationFixture>>,
): RemoteAgentOwnerStore {
  return {
    getBinding: async () => {
      const state = f.read(),
        build = state.builds.find((b) => b.id === state.current)!;
      return {
        runtime: build.runtime,
        expectedEpoch: state.launches[0]!.epoch!,
        connectionId: state.currentConnectionId ?? build.runtime.generation,
      };
    },
    bindConnection: async () => {},
    get: async () => undefined,
    reserve: async (owner) => owner,
    update: async () => {
      throw new Error("unused owner mutation");
    },
    referencedBuildIds: async () => new Set(),
  };
}
export function fixtureLifecycle(
  f: Awaited<ReturnType<typeof publicationFixture>>,
  proof: VerifiedMobilePublication,
) {
  const owners = gatewayFixtureOwnerStore(f);
  return Effect.runPromise(
    makeMobileGatewayLifecycle(proof, gatewayConfiguration).pipe(
      Effect.provideService(BackendInstance, f.owner()),
      Effect.provideService(RemoteAgentRuntimeOwners, owners),
    ),
  );
}
