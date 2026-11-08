import { Effect } from "effect";
import type { ProviderSession } from "@bigbud/contracts/orchestration/provider.ts";

import type { ProviderServiceShape } from "../provider/Services/ProviderService.ts";
import type { TerminalManagerShape } from "../terminal/Services/Manager.ts";
import {
  disconnectConfiguredRemoteAgentTarget,
  isRemoteAgentExecutionTarget,
} from "../remote-agent/remoteAgentDefault.ts";
import { closeSshPasswordSession } from "../ssh/sshSession.ts";
import { forgetSshMonitorTarget } from "../ssh/sshMonitor.connections.ts";
import { type RemoteDisconnectStep, RemoteDisconnectStepError } from "./wsRemoteConnection.ts";

export interface RemoteDisconnectStepDependencies {
  readonly providerService: Pick<ProviderServiceShape, "listSessions" | "stopSession">;
  readonly terminalManager: Pick<TerminalManagerShape, "close" | "listExecutionTargetSessions">;
  /** Agent-transport targets use remote-agent PTYs, which keep running on the host. */
  readonly usesRemoteAgentPty?: (executionTargetId: string) => boolean;
  readonly disconnectRemoteAgent?: (executionTargetId: string, error: Error) => void;
  readonly closePasswordSession?: (executionTargetId: string) => Promise<void>;
  readonly forgetMonitorTarget?: (executionTargetId: string) => void;
}

function sessionUsesTarget(session: ProviderSession, executionTargetId: string): boolean {
  return (
    session.providerRuntimeExecutionTargetId === executionTargetId ||
    session.workspaceExecutionTargetId === executionTargetId ||
    session.executionTargetId === executionTargetId
  );
}

const logItemFailure = (step: string, executionTargetId: string, threadId: string) =>
  Effect.catchCause((cause) =>
    Effect.logWarning("remote workspace disconnect could not close a holder", {
      step,
      executionTargetId,
      threadId,
      cause,
    }),
  );

/** Disconnect teardown in order: provider sessions, direct-SSH terminals, pool, ControlMaster, monitor. */
export function makeRemoteDisconnectSteps(
  dependencies: RemoteDisconnectStepDependencies,
): ReadonlyArray<RemoteDisconnectStep> {
  const { providerService, terminalManager } = dependencies;
  const usesRemoteAgentPty = dependencies.usesRemoteAgentPty ?? isRemoteAgentExecutionTarget;
  const listTerminals = terminalManager.listExecutionTargetSessions;
  return [
    {
      name: "provider-sessions",
      run: (target) =>
        providerService.listSessions().pipe(
          Effect.flatMap((sessions) =>
            Effect.forEach(
              sessions.filter((session) => sessionUsesTarget(session, target)),
              (session) =>
                providerService
                  .stopSession({
                    threadId: session.threadId,
                    ...(session.sessionEpoch !== undefined
                      ? { sessionEpoch: session.sessionEpoch }
                      : {}),
                  })
                  .pipe(logItemFailure("provider-sessions", target, session.threadId)),
              { discard: true },
            ),
          ),
        ),
    },
    {
      name: "direct-ssh-terminals",
      run: (target) =>
        usesRemoteAgentPty(target) || !listTerminals
          ? Effect.void
          : listTerminals(target).pipe(
              Effect.flatMap((terminals) =>
                Effect.forEach(
                  terminals,
                  (terminal) =>
                    terminalManager
                      .close({ threadId: terminal.threadId, terminalId: terminal.terminalId })
                      .pipe(logItemFailure("direct-ssh-terminals", target, terminal.threadId)),
                  { discard: true },
                ),
              ),
            ),
    },
    {
      name: "remote-agent-connections",
      run: (target, error) =>
        Effect.sync(() =>
          (dependencies.disconnectRemoteAgent ?? disconnectConfiguredRemoteAgentTarget)(
            target,
            error,
          ),
        ),
    },
    {
      name: "password-session",
      run: (target) =>
        Effect.tryPromise({
          try: () => (dependencies.closePasswordSession ?? closeSshPasswordSession)(target),
          catch: (cause) => new RemoteDisconnectStepError({ step: "password-session", cause }),
        }),
    },
    {
      name: "ssh-monitor",
      run: (target) =>
        Effect.sync(() => (dependencies.forgetMonitorTarget ?? forgetSshMonitorTarget)(target)),
    },
  ];
}
