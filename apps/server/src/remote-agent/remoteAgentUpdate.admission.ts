import type { RemoteAgentControl } from "./remoteAgentControl.ts";
import type { RemoteAgentAdmissionPreparation } from "./remoteAgentUpdate.admission.types.ts";
import type { makeRemoteAgentDiscovery } from "./remoteAgentUpdate.discovery.ts";
import { readyRemoteAgentStableSelection } from "./remoteAgentAdmission.selection.ts";
import { remoteAgentFailureDetail } from "./remoteAgentFailure.ts";

/** A new connection attempts the configured release before choosing its immutable runtime. */
export function makeRemoteAgentAdmissionPreparation(input: {
  readonly openControl: (target: string) => Promise<RemoteAgentControl>;
  readonly runPreparation: (key: string, run: () => Promise<void>) => Promise<void>;
  readonly discover: ReturnType<typeof makeRemoteAgentDiscovery>;
}) {
  return async (target: string, requestId: string): Promise<RemoteAgentAdmissionPreparation> => {
    if (!/^[a-zA-Z0-9-]{1,64}$/.test(requestId))
      throw new Error("Invalid fresh connection identity.");
    const control = await input.openControl(target);
    let result: RemoteAgentAdmissionPreparation = {};
    await input.runPreparation(`${target}\u0000${control.root}`, async () => {
      const state = await control.registry.read();
      // Replays, including unresolved and retired admissions, keep their exact selection.
      if (
        state.admissions.some((entry) => entry.id === requestId) ||
        state.admissionRetirements?.some((entry) => entry.id === requestId)
      )
        return;
      try {
        result = await input.discover(target, control, {
          refreshSource: true,
          forceRetry: true,
          onResolved: (identity) => {
            result = identity;
          },
        });
      } catch (cause) {
        const current = await control.registry.read().catch(() => undefined);
        const stable =
          current &&
          [current.current, current.predecessor].some((buildId) =>
            readyRemoteAgentStableSelection(current, buildId),
          );
        if (!stable) throw cause;
        result = { ...result, warning: remoteAgentFailureDetail(cause) };
      }
    });
    return result;
  };
}
