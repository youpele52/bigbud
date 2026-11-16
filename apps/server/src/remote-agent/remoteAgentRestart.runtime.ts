import { retireRestartAdmissions } from "./remoteAgentRestart.registry.ts";
import { remoteAgentRestartAttemptId } from "./remoteAgentRestart.identity.ts";
import { buildRemoteAgentSupervisorObservation } from "./remoteAgentSupervisorLiveness.ts";

import { openRemoteAgentControl } from "./remoteAgentControl.ts";
import { buildRemoteAgentSupervisorRestartCommand } from "./remoteAgentSupervisor.ts";
import {
  buildManagedRemoteAgentReplacementLaunch,
  buildRemoteAgentReplacementDeathEvidence,
  buildRemoteAgentReplacementReadiness,
} from "./remoteAgentRuntime.launch.ts";
import { validateRemoteAgentRuntime } from "./remoteAgentRuntime.ts";
import type { RemoteAgentRuntimeBinding } from "./remoteAgentConnectionPool.ts";
import type {
  RemoteAgentRuntimeRestartDependencies,
  RemoteAgentRuntimeRestartRecord,
  RemoteAgentRuntimeRestartRequest,
} from "./remoteAgentRestart.runtime.types.ts";
export class RemoteAgentRestartCompletionError extends Error {}

export const terminalPhases = new Set(["ready", "failed", "unknown"]);

export async function restartRemoteAgentRuntime(
  dependencies: RemoteAgentRuntimeRestartDependencies,
  request: RemoteAgentRuntimeRestartRequest,
  initialBinding?: RemoteAgentRuntimeBinding,
): Promise<RemoteAgentRuntimeRestartRecord> {
  const target = request.expectedWorkspaceExecutionTargetId;
  const attemptId = remoteAgentRestartAttemptId(request.requestId);
  const prior = await dependencies.store.get(request.requestId);
  if (prior && terminalPhases.has(prior.phase)) return prior;
  await dependencies.verifySsh(target);
  const binding = initialBinding ?? (await dependencies.resolveBinding(target));
  if (!binding) throw new Error("The selected remote service is not available.");
  if (binding.runtime.origin !== "managed")
    throw new Error("This remote agent does not advertise verified restart support.");
  const runtime = validateRemoteAgentRuntime(binding.runtime);
  const oldEpoch = prior?.oldEpoch ?? binding.expectedEpoch;
  if (
    prior &&
    (JSON.stringify(prior.runtime) !== JSON.stringify(runtime) ||
      (!(prior.phase === "stopping" || prior.phase === "starting") &&
        prior.oldEpoch !== binding.expectedEpoch))
  )
    return {
      ...prior,
      phase: "unknown",
      message: "The restart request no longer matches the selected runtime.",
    };
  const releaseRetirement = dependencies.beginRetirement
    ? await dependencies.beginRetirement(target, runtime.generation)
    : undefined;
  if (!prior)
    await dependencies.store.put({
      requestId: request.requestId,
      target,
      runtime,
      oldEpoch,
      phase: "prepared",
      message: "Remote service restart prepared.",
    });
  const control = await (dependencies.control?.(target) ?? openRemoteAgentControl(target));
  const reservedState = await control.registry.update((state) => {
    const priorReservation = state.restartReservations.find(
      (entry) => entry.id === request.requestId,
    );
    const active = state.restartReservations.find(
      (entry) =>
        entry.generation === runtime.generation && !["failed", "ready"].includes(entry.phase),
    );
    if (active && active.id !== request.requestId)
      throw new Error("Remote runtime restart is already reserved.");
    if (priorReservation) {
      if (
        priorReservation.expectedEpoch !== oldEpoch ||
        priorReservation.buildId !== `${runtime.version}:${runtime.sha256}:${runtime.targetTriple}`
      )
        throw new Error("Remote restart reservation identity changed.");
      return state;
    }
    return {
      ...state,
      revision: state.revision + 1,
      restartReservations: [
        ...state.restartReservations,
        {
          id: request.requestId,
          buildId: `${runtime.version}:${runtime.sha256}:${runtime.targetTriple}`,
          generation: runtime.generation,
          expectedEpoch: oldEpoch,
          phase: "reserved" as const,
        },
      ],
    };
  });
  const previousAttempt = reservedState.launches.find(
    (launch) =>
      launch.buildId === `${runtime.version}:${runtime.sha256}:${runtime.targetTriple}` &&
      launch.epoch === oldEpoch,
  )?.attemptId;
  const setReservationPhase = async (phase: "ready" | "failed", epoch?: string) => {
    await control.registry.update((state) => {
      if (
        phase === "failed" &&
        state.restartReservations.some(
          (entry) => entry.id === request.requestId && entry.phase === "ready",
        )
      )
        return state;
      if (
        phase === "ready" &&
        (!state.restartReservations.some(
          (entry) =>
            entry.id === request.requestId &&
            ["starting", "stopping", "ready"].includes(entry.phase),
        ) ||
          !state.launches.some(
            (launch) =>
              launch.id === runtime.generation &&
              launch.attemptId === attemptId &&
              launch.epoch === epoch &&
              launch.phase === "ready",
          ))
      )
        throw new Error("Restart launch changed before finalization.");
      return {
        ...state,
        revision: state.revision + 1,
        restartReservations: state.restartReservations.map((entry) =>
          entry.id === request.requestId ? { ...entry, phase } : entry,
        ),
      };
    });
  };

  const publishReplacement = async (epoch: string) => {
    await control.registry.update((state) => {
      const reservation = state.restartReservations.find((entry) => entry.id === request.requestId);
      const launch = state.launches.find((entry) => entry.id === runtime.generation);
      if (
        !reservation ||
        !["starting", "stopping", "ready"].includes(reservation.phase) ||
        !launch ||
        launch.attemptId !== attemptId
      )
        throw new Error("Replacement no longer owns its launch reservation.");
      return {
        ...state,
        revision: state.revision + 1,
        launches: state.launches.map((entry) =>
          entry.id === runtime.generation ? { ...entry, phase: "ready" as const, epoch } : entry,
        ),
        admissions: [
          ...state.admissions.filter((entry) => entry.id !== attemptId),
          { id: attemptId, buildId: launch.buildId, epoch, phase: "ready" as const },
        ],
        pins: [
          ...state.pins.filter((pin) => pin.owner !== `connection:${attemptId}`),
          { owner: `connection:${attemptId}`, buildId: launch.buildId },
        ],
        currentConnectionId:
          state.current === launch.buildId ? attemptId : state.currentConnectionId,
      };
    });
    const replacement = { runtime, expectedEpoch: epoch, connectionId: attemptId };
    await dependencies.bindReplacement?.(target, attemptId, replacement);
    return replacement;
  };
  let completionVerified = false;
  const completeRestart = async (): Promise<RemoteAgentRuntimeRestartRecord> => {
    if (prior?.phase === "stopping" || prior?.phase === "starting") {
      const ready = (
        await control.run(buildRemoteAgentReplacementReadiness(runtime, attemptId))
      ).trim();
      const epoch =
        ready === "ready" && dependencies.verifyReadiness
          ? await dependencies.verifyReadiness(target, runtime)
          : undefined;
      if (epoch && epoch !== oldEpoch) {
        completionVerified = true;
        await control.registry.update((state) =>
          retireRestartAdmissions(
            state,
            `${runtime.version}:${runtime.sha256}:${runtime.targetTriple}`,
            oldEpoch,
            { id: attemptId, epoch },
          ),
        );
        const replacement = await publishReplacement(epoch);
        const retired = { runtime, expectedEpoch: oldEpoch };
        await dependencies.reconnect(target, replacement, retired);
        await dependencies.reconcileRuntime?.(target, retired);
        await setReservationPhase("ready", epoch);
        const record = await dependencies.store.update(request.requestId, (current) => ({
          ...current,
          phase: "ready",
          message: "The remote service was restarted and verified.",
          replacementEpoch: epoch,
        }));
        releaseRetirement?.();
        return record;
      }
      const record = await dependencies.store.update(request.requestId, (current) => ({
        ...current,
        phase: "unknown",
        message:
          "The restart response was lost while stopping; the service was not restarted again.",
      }));
      await setReservationPhase("failed");
      releaseRetirement?.();
      return record;
    }
    if (!previousAttempt || !/^[a-zA-Z0-9-]{1,64}$/.test(previousAttempt))
      throw new Error("The old supervisor has no matching launch identity.");
    // Check admission replay capacity before issuing the stop; publish only after death proof.
    retireRestartAdmissions(
      reservedState,
      `${runtime.version}:${runtime.sha256}:${runtime.targetTriple}`,
      oldEpoch,
    );
    if (!prior || prior.phase === "prepared") {
      await dependencies.store.update(request.requestId, (record) => ({
        ...record,
        phase: "stopping",
        message: "Stopping the remote service.",
      }));
      await control.registry.update((state) => ({
        ...state,
        revision: state.revision + 1,
        restartReservations: state.restartReservations.map((entry) =>
          entry.id === request.requestId ? { ...entry, phase: "stopping" as const } : entry,
        ),
      }));
      const observation = (
        await control.run(`set -eu
${buildRemoteAgentSupervisorObservation(runtime, previousAttempt)}
observe_supervisor
`)
      ).trim();
      if (observation === "live" || observation === "ready") {
        if (dependencies.stopLiveSupervisor === false)
          throw new Error(
            "A live supervisor was not stopped during account boot; retry adoption or repair transport.",
          );
        try {
          await control.run(
            buildRemoteAgentSupervisorRestartCommand({
              binaryPath: runtime.binaryPath,
              statePath: runtime.statePath,
            }),
          );
        } catch {
          // A disconnected stop is safe only if the following independent proof confirms death.
        }
      } else if (!observation.startsWith("exited:") && observation !== "prior-boot-dead") {
        throw new Error("The old supervisor has no verified live or dead identity.");
      }
      const deathEvidence = (
        await control.run(buildRemoteAgentReplacementDeathEvidence(runtime, previousAttempt))
      ).trim();
      if (deathEvidence !== "dead" && deathEvidence !== "prior-boot-dead")
        throw new Error("The old supervisor did not provide verified death evidence.");
      await dependencies.store.update(request.requestId, (record) => ({
        ...record,
        phase: "stopped",
        message: "Remote service stopped; reconnecting.",
      }));
      dependencies.close(target, binding);
    }
    await control.registry.update((state) =>
      retireRestartAdmissions(
        state,
        `${runtime.version}:${runtime.sha256}:${runtime.targetTriple}`,
        oldEpoch,
      ),
    );
    await dependencies.store.update(request.requestId, (record) => ({
      ...record,
      phase: "starting",
      message: "Starting the replacement remote service.",
    }));
    await control.registry.update((state) => ({
      ...state,
      revision: state.revision + 1,
      restartReservations: state.restartReservations.map((entry) =>
        entry.id === request.requestId ? { ...entry, phase: "starting" as const } : entry,
      ),
      launches: state.launches.map((launch) =>
        launch.id === runtime.generation
          ? { ...launch, attemptId, phase: "spawn-uncertain" as const }
          : launch,
      ),
    }));
    const launchResult = (
      await (dependencies.launchReplacement
        ? dependencies.launchReplacement(runtime, attemptId, oldEpoch, previousAttempt)
        : control.run(
            buildManagedRemoteAgentReplacementLaunch(runtime, attemptId, oldEpoch, previousAttempt),
          ))
    ).trim();
    if (launchResult !== "launch-reserved")
      throw new Error("Replacement launch reservation was not acquired.");
    const readiness = (
      await control.run(buildRemoteAgentReplacementReadiness(runtime, attemptId))
    ).trim();
    if (readiness !== "ready")
      throw new Error(`Replacement readiness was not verified (${readiness}).`);
    let authenticatedEpoch: string | undefined;
    if (dependencies.verifyReadiness) {
      const verifiedEpoch = await dependencies.verifyReadiness(target, runtime);
      if (!verifiedEpoch) throw new Error("Replacement handshake did not return an epoch.");
      if (verifiedEpoch === oldEpoch) throw new Error("Replacement still has the old epoch.");
      completionVerified = true;
      authenticatedEpoch = verifiedEpoch;
      const replacementBinding = await publishReplacement(verifiedEpoch);
      await dependencies.reconnect(target, replacementBinding, binding);
    } else {
      await dependencies.reconnect(target);
    }
    const replacementEpoch =
      authenticatedEpoch ?? (await dependencies.resolveBinding(target))?.expectedEpoch;
    if (!replacementEpoch || replacementEpoch === oldEpoch) {
      const record = await dependencies.store.update(request.requestId, (current) => ({
        ...current,
        phase: "unknown",
        message: "The remote service restart outcome could not be verified.",
      }));
      await setReservationPhase("failed");
      releaseRetirement?.();
      return record;
    }
    await dependencies.reconcileRuntime?.(target, binding);
    await setReservationPhase("ready", replacementEpoch);
    const record = await dependencies.store.update(request.requestId, (current) => ({
      ...current,
      phase: "ready",
      message: "The remote service was restarted and verified.",
      replacementEpoch,
    }));
    releaseRetirement?.();
    return record;
  };
  try {
    return await completeRestart();
  } catch (cause) {
    if (completionVerified) {
      releaseRetirement?.();
      throw new RemoteAgentRestartCompletionError(
        "Verified replacement completion needs reconciliation.",
        { cause },
      );
    }
    await setReservationPhase("failed").catch(() => undefined);
    releaseRetirement?.();
    throw cause;
  }
}
