import type { RemoteAgentOperationSnapshot } from "../remote-agent/remoteAgentInstall.operation.ts";
import { waitForRemoteAgentOperation } from "../remote-agent/remoteAgentLocalControl.client.ts";
import {
  isRemoteAgentOperationSnapshot,
  REMOTE_AGENT_CLI_EXIT,
  remoteAgentOutcomeExitCode,
} from "../remote-agent/remoteAgentLocalControl.protocol.ts";

export class RemoteAgentOperationUncertainError extends Error {
  constructor(
    readonly operationId: string,
    readonly target: string,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : "Operation reply was lost.", { cause });
  }
}

export function operationRecovery(operationId: string, target?: string) {
  return {
    operationId,
    ...(target ? { target } : {}),
    outcome: "uncertain" as const,
    recovery: `Run bigbud remote-agent follow ${operationId} with the same --dev/--base-dir options. Unknown or expired does not prove the operation never ran; inspect target status before any new install.`,
  };
}

export async function followRemoteAgentOperation(input: {
  socketPath: string;
  operationId: string;
  target?: string;
  print: (value: unknown, text: string) => void;
  /** Optional actionable line appended to a completed operation's message. */
  hint?: (snapshot: RemoteAgentOperationSnapshot) => string | null;
}): Promise<number> {
  try {
    const response = await waitForRemoteAgentOperation(input.socketPath, input.operationId);
    if (!response.ok) throw new Error(response.error.message);
    if (!isRemoteAgentOperationSnapshot(response.result))
      throw new Error("Invalid operation reply.");
    const hint = input.hint?.(response.result) ?? null;
    input.print(
      hint ? { ...response.result, hint } : response.result,
      hint ? `${response.result.message}\n${hint}` : response.result.message,
    );
    return remoteAgentOutcomeExitCode(response.result.outcome);
  } catch (cause) {
    const recovery = operationRecovery(input.operationId, input.target);
    const message = cause instanceof Error ? cause.message : "Operation outcome is uncertain.";
    input.print({ ok: false, ...recovery, error: { message } }, `${message}\n${recovery.recovery}`);
    return REMOTE_AGENT_CLI_EXIT.uncertain;
  }
}
