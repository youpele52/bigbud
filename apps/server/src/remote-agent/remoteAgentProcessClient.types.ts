import { RemoteAgentConnectionError } from "./remoteAgentConnection.ts";
import type { RemoteAgentProcessCompleted } from "./remoteAgentProtocol.ts";
import { remoteAgentProcessTerminalEvidence } from "./remoteAgentTerminalEvidence.ts";

export interface RemoteAgentProcessResult {
  readonly accepted: boolean;
  readonly duplicate: boolean;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly completed: RemoteAgentProcessCompleted;
  /**
   * The attach cursor fell behind the agent's retained output: the exit code
   * is verified but some output was lost ("finished with exit N, output
   * partly lost"). `completed.outputTruncated` is also set.
   */
  readonly replayGap?: boolean;
}

export interface RemoteAgentProcessRunInput {
  readonly workspaceHandle: string;
  readonly operationId: string;
  readonly requestDigest: Uint8Array;
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly environment?: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  readonly stdin?: Uint8Array;
  readonly requestId?: string;
  /**
   * Stops a reattach that waits for the link to come back, for example when the turn or the
   * owner was stopped. It never cancels the remote operation itself.
   */
  readonly signal?: AbortSignal;
}

export class RemoteAgentProcessError extends Error {
  readonly _tag = "RemoteAgentProcessError";

  constructor(
    readonly code: string,
    message: string,
    /** `cancelled`: this client stopped waiting; the remote operation's outcome is not known. */
    readonly outcome: "unknown" | "terminal" | "rejected" | "cancelled" = "unknown",
  ) {
    super(message);
    this.name = "RemoteAgentProcessError";
  }
}

export function append(chunks: Uint8Array[], bytes: Uint8Array): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, bytes.length);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  result.set(bytes, offset);
  return result;
}

export function errorFromCompleted(completed: RemoteAgentProcessCompleted): Error | null {
  if (remoteAgentProcessTerminalEvidence(completed) !== "verified-terminal")
    return new RemoteAgentProcessError(
      "PROCESS_OUTCOME_UNKNOWN",
      "Remote process history expired without a verified execution outcome.",
    );
  return completed.errorCode && completed.errorCode !== "NONZERO_EXIT"
    ? new RemoteAgentProcessError(completed.errorCode, completed.errorMessage, "terminal")
    : null;
}

export function isUnknownOperationError(cause: unknown): boolean {
  return (
    (cause instanceof RemoteAgentProcessError && cause.code === "PROCESS_OUTCOME_UNKNOWN") ||
    (cause instanceof RemoteAgentConnectionError &&
      cause.message.includes("operation is unknown or expired"))
  );
}

export function outcomeUnknownAfterRetention(lastCause: unknown): RemoteAgentProcessError {
  const detail = lastCause instanceof Error ? ` Last transport error: ${lastCause.message}.` : "";
  return new RemoteAgentProcessError(
    "PROCESS_OUTCOME_UNKNOWN",
    `Remote process could not be reattached before its retained result would have expired; the operation was not replayed.${detail}`,
  );
}

/** The caller stopped a reattach: not "outcome unknown", and nothing is respawned. */
export function reattachCancelled(): RemoteAgentProcessError {
  return new RemoteAgentProcessError(
    "PROCESS_REATTACH_CANCELLED",
    "Reattaching to the remote process was cancelled; the operation was not replayed.",
    "cancelled",
  );
}
