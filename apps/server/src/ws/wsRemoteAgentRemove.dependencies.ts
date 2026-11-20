import type { ServerRemoteConnectionInput } from "@bigbud/contracts/server/server.remoteConnection.ts";

import type { ProviderServiceShape } from "../provider/Services/ProviderService.ts";
import { remoteAgentOwners } from "../remote-agent/remoteAgentOwners.ts";
import type { RemoteAgentInstaller } from "../remote-agent/remoteAgentServerLayer.ts";
import type { RemoteAgentUpdateCoordinatorShape } from "../remote-agent/remoteAgentUpdate.coordinator.ts";
import type { TerminalManagerShape } from "../terminal/Services/Manager.ts";
import type { RemoveRemoteAgentDependencies } from "./wsRemoteAgentRemove.ts";
import {
  switchRemoteAgentWorkspacesToDirectSsh,
  type RemoteAgentWorkspaceSwitchDependencies,
} from "./wsRemoteAgentRemove.workspaces.ts";
import { disconnectExecutionTargetEffect } from "./wsRemoteConnection.ts";
import { makeRemoteDisconnectSteps, sessionUsesTarget } from "./wsRemoteConnection.steps.ts";
import type { ProviderSession } from "@bigbud/contracts/orchestration/provider.ts";
import { Effect } from "effect";

/** A session that is starting, running or mid-turn is live work removal must not interrupt. */
function isLiveProviderSession(session: ProviderSession): boolean {
  return (
    session.status === "running" ||
    session.status === "connecting" ||
    session.activeTurnId !== undefined
  );
}

/** One composition for the app's Remove agent RPC and the local `remote-agent remove` CLI. */
export function makeRemoveRemoteAgentDependencies(input: {
  readonly remoteAgentInstaller?: RemoteAgentInstaller | undefined;
  readonly remoteAgentUpdateCoordinator?: Pick<RemoteAgentUpdateCoordinatorShape, "forget">;
  readonly providerService: Pick<ProviderServiceShape, "listSessions" | "stopSession">;
  readonly terminalManager: Pick<TerminalManagerShape, "close" | "listExecutionTargetSessions">;
  readonly workspaces: RemoteAgentWorkspaceSwitchDependencies;
}): RemoveRemoteAgentDependencies {
  // Removal disconnects the host but never stops provider sessions; running ones block it.
  const steps = makeRemoteDisconnectSteps({
    providerService: input.providerService,
    terminalManager: input.terminalManager,
  }).filter((step) => step.name !== "provider-sessions");
  return {
    remoteAgentInstaller: input.remoteAgentInstaller,
    forgetTarget: async (target) => {
      let store;
      try {
        store = remoteAgentOwners();
      } catch {
        return; // No durable owner store in this composition: nothing was selected.
      }
      await store.forgetTarget?.(target);
    },
    forgetUpdateState: (target) => input.remoteAgentUpdateCoordinator?.forget?.(target),
    liveProviderSessionBlockers: (target) =>
      input.providerService.listSessions().pipe(
        Effect.map((sessions) =>
          sessions
            .filter(
              (session) => sessionUsesTarget(session, target) && isLiveProviderSession(session),
            )
            .map((session) => ({
              kind: "process" as const,
              label: `A ${session.provider} chat is still working on this host`,
            })),
        ),
      ),
    disconnect: (target) =>
      disconnectExecutionTargetEffect(
        { executionTargetId: target as ServerRemoteConnectionInput["executionTargetId"] },
        steps,
      ).pipe(Effect.map((result) => result.disconnected)),
    switchWorkspacesToDirectSsh: (target) =>
      switchRemoteAgentWorkspacesToDirectSsh(target, input.workspaces),
  };
}
