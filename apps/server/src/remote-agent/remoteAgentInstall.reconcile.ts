import type { RemoteAgentControl } from "./remoteAgentControl.ts";
import { isRemoteAgentControllerAlive } from "./remoteAgentController.ts";
import { buildRemoteAgentStageFenceRevokeCommand } from "./remoteAgentInstall.stageFence.ts";
import { releaseRemoteAgentStage } from "./remoteAgentInstall.registry.transitions.ts";

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** A matching durable child-exit receipt plus a free inherited launch lock proves managed runtime death. */
export async function reconcileRemoteAgentLaunchExits(control: RemoteAgentControl): Promise<void> {
  const snapshot = await control.registry.read();
  for (const launch of snapshot.launches
    .filter((entry) => entry.attemptId && entry.phase !== "proven-dead")
    .slice(0, 8)) {
    const build = snapshot.builds.find((entry) => entry.id === launch.buildId);
    if (!build || build.runtime.origin !== "managed") continue;
    const result = await control.run(`set -eu
state=${quote(build.runtime.statePath)}
if test ! -d "$state" || test -L "$state"; then printf unknown; exit 0; fi
test "$(readlink -f -- "$state")" = "$state"
test "$(stat -c '%u' -- "$state")" = "$(id -u)"
test "$(stat -c '%a' -- "$state")" = 700
for name in launch.lock launch.intent launch.exit; do
  file="$state/$name"
  if test ! -f "$file" || test -L "$file"; then printf unknown; exit 0; fi
  test "$(stat -c '%u' -- "$file")" = "$(id -u)"
  test "$(stat -c '%a' -- "$file")" = 600
  test "$(stat -c '%h' -- "$file")" = 1
  test "$(wc -c < "$file")" -le 64
done
exec 8< "$state/launch.lock"
if ! flock -n -x 8; then printf live; exit 0; fi
test "$(cat "$state/launch.intent")" = ${quote(launch.attemptId!)}
case "$(cat "$state/launch.exit")" in
  [0-9]|[0-9][0-9]|[0-9][0-9][0-9]) printf dead ;;
  *) printf unknown ;;
esac
`);
    if (result !== "dead") continue;
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
