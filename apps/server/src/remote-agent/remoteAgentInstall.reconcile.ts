import { buildRemoteAgentSupervisorObservation } from "./remoteAgentSupervisorLiveness.ts";
import type { RemoteAgentControl } from "./remoteAgentControl.ts";
import { isRemoteAgentControllerAlive } from "./remoteAgentController.ts";
import { buildRemoteAgentStageFenceRevokeCommand } from "./remoteAgentInstall.stageFence.ts";
import { releaseRemoteAgentStage } from "./remoteAgentInstall.registry.transitions.ts";

/** A matching launch with a free lock and exit receipt or distinct prior-boot proof is dead. */
export async function reconcileRemoteAgentLaunchExits(
  control: RemoteAgentControl,
  options: { readonly buildId?: string } = {},
): Promise<void> {
  const snapshot = await control.registry.read();
  for (const launch of snapshot.launches
    .filter(
      (entry) =>
        entry.attemptId &&
        entry.phase !== "proven-dead" &&
        (options.buildId === undefined || entry.buildId === options.buildId),
    )
    .slice(0, 8)) {
    const build = snapshot.builds.find((entry) => entry.id === launch.buildId);
    if (!build || build.runtime.origin !== "managed") continue;
    const result = await control.run(`set -eu
${buildRemoteAgentSupervisorObservation(build.runtime, launch.attemptId!)}
case "$(observe_supervisor)" in
  exited:*) printf dead ;;
  prior-boot-dead) printf prior-boot-dead ;;
  *) printf unknown ;;
esac
`);
    if (result !== "dead" && result !== "prior-boot-dead") continue;
    await control.registry.update((current) => {
      const entry = current.launches.find((value) => value.id === launch.id);
      if (!entry || entry.attemptId !== launch.attemptId || entry.epoch !== launch.epoch)
        return current;
      const recoveryPinned = current.pins.some(
        (pin) =>
          pin.buildId === build.id &&
          !pin.owner.startsWith("activation:") &&
          !pin.owner.startsWith("connection:"),
      );
      return {
        ...current,
        revision: current.revision + 1,
        launches: current.launches.map((value) =>
          value.id === launch.id ? { ...value, phase: "proven-dead" } : value,
        ),
        pins: current.pins.filter(
          (pin) =>
            pin.buildId !== build.id ||
            (!pin.owner.startsWith("activation:") &&
              (recoveryPinned || !pin.owner.startsWith("connection:"))),
        ),
      };
    });
  }
}

/**
 * Reclaim a stage only after both halves of its ownership proof agree: the
 * controller is gone and the remote command no longer holds the stage fence.
 */
export async function reconcileRemoteAgentStages(control: RemoteAgentControl): Promise<void> {
  const snapshot = await control.registry.read();
  for (const stage of snapshot.stages
    .filter(
      (entry) =>
        (entry.phase === "reserved" ||
          (entry.phase === "failed" && entry.failure === "ambiguous")) &&
        entry.controllerId !== undefined &&
        entry.controllerPid !== undefined &&
        entry.controllerStartedAt !== undefined,
    )
    .slice(0, 8)) {
    const alive = await isRemoteAgentControllerAlive({
      id: stage.controllerId!,
      pid: stage.controllerPid!,
      startedAt: stage.controllerStartedAt!,
    });
    if (alive) continue;
    let result: string;
    try {
      result = await control.run(buildRemoteAgentStageFenceRevokeCommand(control.root, stage.id));
    } catch {
      continue;
    }
    if (result.trim() !== "revoked") continue;
    await control.registry.update((current) =>
      releaseRemoteAgentStage(current, stage.id, {
        id: stage.controllerId!,
        pid: stage.controllerPid!,
        startedAt: stage.controllerStartedAt!,
      }),
    );
  }
}
