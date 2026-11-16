import {
  parseRemoteAgentRegistry,
  type RemoteAgentRegistry,
} from "./remoteAgentInstall.registry.ts";

/** Retain replay outcomes while releasing connections to a supervisor whose death was proven. */
export function retireRestartAdmissions(
  state: RemoteAgentRegistry,
  buildId: string,
  epoch: string,
  replacement?: { readonly id: string; readonly epoch: string },
): RemoteAgentRegistry {
  const admissions = state.admissions.filter(
    (entry) =>
      entry.buildId === buildId &&
      !(entry.id === replacement?.id && entry.epoch === replacement.epoch),
  );
  if (admissions.some((entry) => entry.phase !== "ready" || entry.epoch !== epoch))
    throw new Error("Restart cannot replace unresolved or mismatched admissions.");
  const ids = new Set(admissions.map((entry) => entry.id));
  return parseRemoteAgentRegistry(
    JSON.stringify({
      ...state,
      revision: state.revision + 1,
      admissions: state.admissions.filter((entry) => !ids.has(entry.id)),
      admissionRetirements: [
        ...(state.admissionRetirements ?? []),
        ...admissions.map(({ phase: _phase, ...entry }) => ({
          ...entry,
          outcome: entry.outcome ?? "selected",
        })),
      ],
      currentConnectionId:
        state.currentConnectionId && ids.has(state.currentConnectionId)
          ? null
          : state.currentConnectionId,
      pins: state.pins.filter(
        (pin) =>
          !admissions.some(
            (entry) =>
              pin.owner === `connection:${entry.id}` ||
              pin.owner.startsWith(`activation:${entry.id}:`),
          ),
      ),
    }),
  );
}
