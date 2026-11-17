import { remoteAgentRestartAttemptId } from "../remote-agent/remoteAgentRestart.identity.ts";
import {
  remoteAgentBuildId,
  remoteAgentRuntimeEqual,
  type RemoteAgentRuntime,
} from "../remote-agent/remoteAgentRuntime.ts";
import type { RemoteAgentRegistry } from "../remote-agent/remoteAgentInstall.registry.ts";
import type {
  RemoteAgentRuntimeRestartRecord,
  RemoteAgentRuntimeRestartStore,
} from "../remote-agent/remoteAgentRestart.runtime.types.ts";
import type { LocalSupervisorControl } from "./localSupervisorControl.ts";

/** One replacement per dead predecessor epoch, not per boot: after an explicit stop or a settled
 * Rust exit on this boot, the next start must replace the new epoch as well. An unfinished
 * replacement keeps its id (its binding is not published yet), so it resumes. */
export function accountBootRequestId(
  state: RemoteAgentRegistry,
  target: string,
  bootId: string,
  binding: { readonly runtime: RemoteAgentRuntime; readonly expectedEpoch: string },
): string {
  const prefix = `account-boot:${target}:${bootId}:${binding.runtime.generation}:`;
  return (
    state.restartReservations.find(
      (entry) => entry.id.startsWith(prefix) && !["failed", "ready"].includes(entry.phase),
    )?.id ?? `${prefix}${binding.expectedEpoch}`
  );
}

/** Account-boot reservations are keyed by boot and predecessor epoch, so they would otherwise
 * grow with every replacement until the registry budget refuses all writes. A new reservation
 * drops this account's finished history: every `ready` row, and `failed` rows from earlier boots
 * (a reboot already proves their supervisors dead). A `failed` row of the current boot stays: it
 * blocks retrying that exact replacement until it is repaired. Unfinished rows always stay. */
export function settledBootReservationsRetained(
  state: RemoteAgentRegistry,
  target: string,
  requestId: string,
): RemoteAgentRegistry["restartReservations"] {
  const account = `account-boot:${target}:`;
  if (!requestId.startsWith(account)) return state.restartReservations;
  const boot = `${account}${requestId.slice(account.length).split(":")[0]}:`;
  return state.restartReservations.filter(
    (entry) =>
      !entry.id.startsWith(account) ||
      !(entry.phase === "ready" || (entry.phase === "failed" && !entry.id.startsWith(boot))),
  );
}

/** Boot progress is a view of the same P4 reservation, never a project or second owner database. */
export function makeLocalSupervisorBootProgressStore(input: {
  readonly control: Pick<LocalSupervisorControl, "targetId" | "openControl">;
  readonly runtime: RemoteAgentRuntime;
  readonly oldEpoch: string;
  readonly requestId: string;
}): RemoteAgentRuntimeRestartStore {
  const buildId = remoteAgentBuildId(input.runtime);
  const assertId = (id: string) => {
    if (id !== input.requestId)
      throw new Error("Boot progress belongs to another runtime attempt.");
  };
  const progress = (state: RemoteAgentRegistry): RemoteAgentRuntimeRestartRecord | undefined => {
    const row = state.restartReservations.find((entry) => entry.id === input.requestId);
    if (!row) return undefined;
    if (
      row.buildId !== buildId ||
      row.generation !== input.runtime.generation ||
      row.expectedEpoch !== input.oldEpoch
    )
      throw new Error("Boot restart reservation identity changed; preserve it for repair.");
    const launch = state.launches.find(
      (entry) => entry.id === row.generation && entry.buildId === buildId,
    );
    if (
      row.phase === "ready" &&
      (!launch ||
        launch.phase !== "ready" ||
        launch.epoch === input.oldEpoch ||
        launch.attemptId !== remoteAgentRestartAttemptId(input.requestId))
    )
      throw new Error("Boot completion has no replacement epoch evidence.");
    return {
      requestId: input.requestId,
      target: input.control.targetId,
      runtime: input.runtime,
      oldEpoch: input.oldEpoch,
      phase: row.phase === "reserved" ? "prepared" : row.phase === "failed" ? "unknown" : row.phase,
      message:
        row.phase === "ready"
          ? "The account supervisor replacement was verified."
          : "Account supervisor restart requires canonical reconciliation.",
      ...(row.phase === "ready" && launch ? { replacementEpoch: launch.epoch } : {}),
    };
  };
  const assertRecord = (record: RemoteAgentRuntimeRestartRecord) => {
    if (
      record.requestId !== input.requestId ||
      record.target !== input.control.targetId ||
      record.oldEpoch !== input.oldEpoch ||
      !remoteAgentRuntimeEqual(record.runtime, input.runtime)
    )
      throw new Error("Boot progress cannot change immutable runtime identity.");
  };
  return {
    get: async (id) => {
      assertId(id);
      return progress(
        await (await input.control.openControl(input.control.targetId)).registry.read(),
      );
    },
    put: async (record) => {
      assertRecord(record);
      if (record.phase !== "prepared")
        throw new Error("Boot restart must reserve before stopping.");
      await (
        await input.control.openControl(input.control.targetId)
      ).registry.update((state) => {
        const build = state.builds.find((entry) => entry.id === buildId);
        if (
          !build?.authenticated ||
          build.binary !== "present" ||
          state.retirementReservations.some((entry) => entry.buildId === buildId) ||
          state.restartReservations.some(
            (entry) =>
              entry.generation === input.runtime.generation &&
              entry.id !== input.requestId &&
              !["failed", "ready"].includes(entry.phase),
          )
        )
          throw new Error("Another canonical runtime operation owns boot reservation.");
        if (progress(state)) return state;
        return {
          ...state,
          revision: state.revision + 1,
          restartReservations: [
            ...settledBootReservationsRetained(state, input.control.targetId, input.requestId),
            {
              id: input.requestId,
              buildId,
              generation: input.runtime.generation,
              expectedEpoch: input.oldEpoch,
              phase: "reserved",
            },
          ],
        };
      });
    },
    update: async (id, transition) => {
      assertId(id);
      let result: RemoteAgentRuntimeRestartRecord | undefined;
      await (
        await input.control.openControl(input.control.targetId)
      ).registry.update((state) => {
        const current = progress(state);
        if (!current) throw new Error("Boot runtime restart is not reserved.");
        result = transition(current);
        assertRecord(result);
        const phase =
          result.phase === "prepared"
            ? "reserved"
            : result.phase === "unknown"
              ? "failed"
              : result.phase;
        return {
          ...state,
          revision: state.revision + 1,
          restartReservations: state.restartReservations.map((row) =>
            row.id === id ? { ...row, phase } : row,
          ),
        };
      });
      if (!result) throw new Error("Boot progress was not committed.");
      return result;
    },
  };
}
