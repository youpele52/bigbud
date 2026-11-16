import {
  remoteAgentBuildId,
  remoteAgentRuntimeEqual,
  type RemoteAgentRuntime,
} from "../remote-agent/remoteAgentRuntime.ts";
import type { LocalSupervisorControl } from "./localSupervisorControl.ts";

/** Read under the existing registry CAS lock; publication is protected by this durable launch row. */
export async function assertLocalSupervisorServiceReservation(
  control: LocalSupervisorControl,
  runtime: RemoteAgentRuntime,
  attemptId: string,
): Promise<void> {
  const owner = await control.openControl(control.targetId);
  await owner.registry.update((state) => {
    const buildId = remoteAgentBuildId(runtime);
    const build = state.builds.find((entry) => entry.id === buildId);
    if (
      !build?.authenticated ||
      build.binary !== "present" ||
      !remoteAgentRuntimeEqual(build.runtime, runtime) ||
      state.retirementReservations.some((entry) => entry.buildId === buildId) ||
      !state.launches.some(
        (entry) =>
          entry.id === runtime.generation &&
          entry.buildId === buildId &&
          entry.attemptId === attemptId &&
          entry.phase === "spawn-uncertain",
      )
    )
      throw new Error(
        "Service launch requires the existing signed P4 reservation, without retirement or deletion.",
      );
    return { ...state, revision: state.revision + 1 };
  });
}
