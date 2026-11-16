import type { RemoteAgentControl } from "./remoteAgentControl.ts";
import {
  parseRemoteAgentRegistry,
  type RemoteAgentRegistry,
} from "./remoteAgentInstall.registry.ts";
import { buildRemoteAgentSupervisorObservation } from "./remoteAgentSupervisorLiveness.ts";
import { RemoteAgentAdmissionError } from "./remoteAgentAdmission.types.ts";

/** Admission publication cannot race a retired request or a reserved replacement launch. */
export function assertPreparedRemoteAgentAdmission(
  current: RemoteAgentRegistry,
  expected: RemoteAgentRegistry,
  requestId: string,
  buildId: string,
) {
  const admission = current.admissions.find((entry) => entry.id === requestId);
  const launch = current.launches.find((entry) => entry.buildId === buildId);
  if (
    admission?.phase !== "prepared" ||
    admission.buildId !== buildId ||
    launch?.phase !== "ready" ||
    !launch.epoch ||
    JSON.stringify(admission) !==
      JSON.stringify(expected.admissions.find((entry) => entry.id === requestId)) ||
    JSON.stringify(launch) !==
      JSON.stringify(expected.launches.find((entry) => entry.buildId === buildId)) ||
    JSON.stringify(current.builds.find((entry) => entry.id === buildId)) !==
      JSON.stringify(expected.builds.find((entry) => entry.id === buildId)) ||
    current.restartReservations.some(
      (entry) => entry.buildId === buildId && !["failed", "ready"].includes(entry.phase),
    )
  )
    throw new RemoteAgentAdmissionError("ADMISSION_CONFLICT", "Admission changed concurrently.");
  return admission;
}

/** A failed readiness check is not death proof. Settle only its exact, unchanged attempt. */
export async function reconcileFailedRemoteAgentAdmission(
  control: RemoteAgentControl,
  failed: RemoteAgentRegistry | undefined,
  requestId: string,
): Promise<void> {
  if (!failed) return;
  const admission = failed.admissions.find((entry) => entry.id === requestId);
  if (!admission || admission.phase !== "prepared" || admission.epoch !== "") return;
  const build = failed.builds.find((entry) => entry.id === admission.buildId);
  const launch = failed.launches.find((entry) => entry.buildId === admission.buildId);
  if (
    !build ||
    build.runtime.origin !== "managed" ||
    build.binary !== "present" ||
    !launch ||
    launch.id !== build.runtime.generation ||
    launch.phase !== "ready" ||
    !launch.epoch ||
    !launch.attemptId ||
    failed.restartReservations.some(
      (entry) => entry.buildId === build.id && !["failed", "ready"].includes(entry.phase),
    ) ||
    failed.retirementReservations.some(
      (entry) => entry.buildId === build.id && !["failed", "tombstoned"].includes(entry.phase),
    ) ||
    !failed.pins.some(
      (pin) => pin.owner === `activation:${requestId}:${launch.id}` && pin.buildId === build.id,
    ) ||
    failed.pins.some((pin) => pin.owner === `connection:${requestId}`)
  )
    return;
  try {
    const current = await control.registry.read();
    const identity = JSON.stringify(failed);
    if (JSON.stringify(current) !== identity) return;
    const epoch = `'${launch.epoch.replaceAll("'", "'\\''")}'`;
    const observed = (
      await control.run(`set -eu
# Failed admission death observation: no launch, stop, or replay.
${buildRemoteAgentSupervisorObservation(build.runtime, launch.attemptId)}
test -f "$state/epoch" && test ! -L "$state/epoch" &&
test "$(stat -c '%u' -- "$state/epoch")" = "$(id -u)" &&
# Native AgentState writes owner-only 0700; older private epoch files may be 0600.
{ test "$(stat -c '%a' -- "$state/epoch")" = 600 || test "$(stat -c '%a' -- "$state/epoch")" = 700; } &&
test "$(stat -c '%h' -- "$state/epoch")" = 1 &&
test "$(wc -c < "$state/epoch")" -le 256 &&
test "$(cat "$state/epoch")" = ${epoch} || { printf unknown; exit 0; }
observe_supervisor
`)
    ).trim();
    if (!/^exited:[0-9]{1,3}$/.test(observed) && observed !== "prior-boot-dead") return;
    await control.registry.update((state) => {
      // Compare the whole captured revision/identity, including pins and concurrent reservations.
      // A retry of the CAS must never apply old proof to a new admission or launch.
      if (JSON.stringify(state) !== identity) return state;
      const { phase: _phase, ...entry } = admission;
      return parseRemoteAgentRegistry(
        JSON.stringify({
          ...state,
          revision: state.revision + 1,
          admissions: state.admissions.filter((item) => item.id !== requestId),
          admissionRetirements: [
            ...(state.admissionRetirements ?? []),
            { ...entry, outcome: "rejected", failureCode: "SUPERVISOR_DEAD" },
          ],
          // Other connections, work, and earlier fallback attempts retain their pins.
          pins: state.pins.filter((pin) => pin.owner !== `activation:${requestId}:${launch.id}`),
        }),
      );
    });
  } catch {
    // Missing/ambiguous proof, full replay history, or a lost CAS reply never permits clearing.
    // The original admission error remains the caller's result; a committed rejection is durable.
  }
}
