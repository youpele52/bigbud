import type { RemoteAgentArtifact } from "./remoteAgentArtifact.ts";
import type { RemoteAgentControl } from "./remoteAgentControl.ts";
import type { RemoteAgentRegistryBuild } from "./remoteAgentInstall.registry.ts";
import type { RemoteAgentInventory } from "./remoteAgentUpdate.inventory.ts";
import {
  failRemoteAgentStage,
  releaseRemoteAgentStage,
  reserveRemoteAgentStage,
  publishRemoteAgentStage,
} from "./remoteAgentInstall.registry.transitions.ts";
import { validateRemoteAgentRuntime } from "./remoteAgentRuntime.ts";
import { currentRemoteAgentController } from "./remoteAgentController.ts";
import { markRemoteAgentUpdate, reserveRemoteAgentUpdate } from "./remoteAgentUpdate.state.ts";

export class RemoteAgentStageDefinitiveError extends Error {
  readonly _tag = "RemoteAgentStageDefinitiveError";

  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "RemoteAgentStageDefinitiveError";
  }
}

export class RemoteAgentCapacityUnavailableError extends Error {
  readonly _tag = "RemoteAgentCapacityUnavailableError";

  constructor(readonly status: "waiting-for-capacity" | "capacity-noncompliant") {
    super(
      status === "capacity-noncompliant"
        ? "Remote agent installation root is over capacity or has uncertain ownership."
        : "Both remote agent storage slots are occupied; installation is waiting for safe retirement.",
    );
    this.name = "RemoteAgentCapacityUnavailableError";
  }
}

export type RemoteAgentCapacityPreparationResult = "not-needed" | "reclaimed" | "deferred";

/** Reserve before touching immutable bytes; publication is idempotent by durable intent. */
export async function stageRemoteAgentBuild<A>(input: {
  readonly control: RemoteAgentControl;
  readonly artifact: RemoteAgentArtifact;
  readonly authenticated: boolean;
  readonly signal?: AbortSignal;
  readonly prepareCapacity?: (input: {
    readonly control: RemoteAgentControl;
    readonly build: RemoteAgentRegistryBuild;
    readonly inventory: RemoteAgentInventory;
  }) => Promise<RemoteAgentCapacityPreparationResult>;
  readonly installAndCheck: (binaryPath: string, reservationId: string) => Promise<A>;
}): Promise<A> {
  const { artifact, control } = input;
  const id = `${artifact.version}:${artifact.sha256}:${artifact.targetTriple}`;
  const intentId = `update-${artifact.sha256}`;
  const controller = currentRemoteAgentController();
  const generation = `g-${artifact.sha256.slice(0, 24)}`;
  const statePath = `${control.root}/runtimes/${generation}`;
  const build = validateRemoteAgentRuntime({
    generation,
    version: artifact.version,
    sha256: artifact.sha256,
    buildDigest: artifact.buildDigest,
    targetTriple: artifact.targetTriple,
    origin: "managed",
    binaryPath: `${control.root}/bin/${artifact.version}/${artifact.sha256}/bigbud-remote-agent`,
    statePath,
    socketPath: `${statePath}/supervisor.sock`,
    logPath: `${statePath}/supervisor.log`,
  });
  const registryBuild = {
    id,
    health: "staged" as const,
    promotion: 0,
    authenticated: input.authenticated,
    binary: "absent" as const,
    runtime: build,
  };
  if (control.inventory) {
    let inventory = await control.inventory();
    if (input.prepareCapacity) {
      const capacity = await input.prepareCapacity({ control, build: registryBuild, inventory });
      if (capacity === "reclaimed") inventory = await control.inventory();
    }
    const reserved = await control.registry.update((state) => {
      const existing = state.builds.find((build) => build.id === id);
      return reserveRemoteAgentUpdate({
        state,
        requestId: intentId,
        build: existing ?? registryBuild,
        inventory,
        controllerId: controller.id,
      }).state;
    });
    const update = reserved.updates.find((entry) => entry.requestId === intentId);
    if (update?.phase === "waiting-for-capacity") {
      throw new RemoteAgentCapacityUnavailableError(
        inventory.noncompliant ? "capacity-noncompliant" : "waiting-for-capacity",
      );
    }
    await control.registry.update((state) =>
      reserveRemoteAgentStage(
        state,
        intentId,
        state.builds.find((entry) => entry.id === id) ?? registryBuild,
        controller,
      ),
    );
    await control.registry.update((state) =>
      markRemoteAgentUpdate(state, { requestId: intentId, buildId: id, phase: "installing" }),
    );
  }
  await control.registry.update((state) => {
    const existing = state.builds.find((build) => build.id === id);
    return reserveRemoteAgentStage(state, intentId, existing ?? registryBuild, controller);
  });
  const binaryPath = `${control.root}/bin/${artifact.version}/${artifact.sha256}/bigbud-remote-agent`;
  let result: A;
  try {
    result = await input.installAndCheck(binaryPath, intentId);
  } catch (cause) {
    try {
      await control.registry.update((state) =>
        failRemoteAgentStage(
          state,
          intentId,
          cause instanceof RemoteAgentStageDefinitiveError ? "definitive" : "ambiguous",
        ),
      );
      if (control.inventory) {
        await control.registry.update((state) =>
          markRemoteAgentUpdate(state, {
            requestId: intentId,
            buildId: id,
            phase: cause instanceof RemoteAgentStageDefinitiveError ? "failed" : "uncertain",
            outcome: cause instanceof RemoteAgentStageDefinitiveError ? "failed" : "uncertain",
          }),
        );
      }
    } catch {
      // Preserve the reservation when failure classification cannot be durably published.
    }
    throw cause;
  }
  if (input.signal?.aborted) {
    await control.registry.update((state) => releaseRemoteAgentStage(state, intentId, controller));
    if (control.inventory)
      await control.registry.update((state) =>
        markRemoteAgentUpdate(state, {
          requestId: intentId,
          buildId: id,
          phase: "uncertain",
          outcome: "uncertain",
        }),
      );
    throw input.signal.reason ?? new DOMException("caller", "AbortError");
  }
  try {
    await control.registry.update((state) => {
      const published = publishRemoteAgentStage(state, intentId);
      if (published === state) return state;
      return {
        ...published,
        builds: published.builds.map((build) =>
          build.id === id
            ? Object.assign({}, build, {
                authenticated: build.authenticated || input.authenticated,
                health: build.health === "quarantined" ? "staged" : build.health,
              })
            : build,
        ),
      };
    });
  } catch (cause) {
    const observed = await control.registry.read();
    if (!observed.stages.some((stage) => stage.id === intentId && stage.phase === "published"))
      throw cause;
  }
  if (control.inventory)
    await control.registry.update((state) =>
      markRemoteAgentUpdate(state, {
        requestId: intentId,
        buildId: id,
        phase: "checking",
      }),
    );
  return result;
}
