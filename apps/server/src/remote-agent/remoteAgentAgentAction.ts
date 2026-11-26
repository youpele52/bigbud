import {
  sanitizeRemoteAgentStderr,
  RemoteAgentRemoteCommandError,
} from "./remoteAgentDiagnostics.ts";
import type { RemoteAgentCommandStage } from "./remoteAgentDiagnostics.ts";

/**
 * Enum-only owner verbs. The owner compiles every program, argument, cwd and
 * environment value; callers name a verb and (for install/update) supply one
 * exact verified artifact.
 */
export const REMOTE_AGENT_AGENT_ACTIONS = [
  "platformProbe",
  "install",
  "update",
  "remove",
  "status",
  "start",
  "stop",
  "wake",
] as const;

export type RemoteAgentAgentAction = (typeof REMOTE_AGENT_AGENT_ACTIONS)[number];

/** Only these verbs carry artifact bytes, and only on the remote child's stdin. */
export type RemoteAgentArtifactAction = Extract<RemoteAgentAgentAction, "install" | "update">;

export interface RemoteAgentAgentArtifact {
  readonly version: string;
  readonly sha256: string;
  readonly size: number;
  readonly targetTriple: string;
  readonly bytes: Uint8Array;
}

export interface RemoteAgentAgentOperation {
  readonly executionTargetId: string;
  readonly action: RemoteAgentAgentAction;
  /** Client-generated. Reusing it reattaches; it never replays the operation. */
  readonly operationId: Uint8Array;
  readonly artifact?: RemoteAgentAgentArtifact;
  /** Read the recorded outcome only; an unknown id refuses instead of running. */
  readonly reattach?: boolean;
}

export interface RemoteAgentAgentOutcome {
  readonly action: RemoteAgentAgentAction;
  readonly operationId: Uint8Array;
  readonly exitCode: number | undefined;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  /** A partial install or lost acknowledgement: reattach, never replay. */
  readonly outcomeUnknown: boolean;
  /** The recorded outcome of an earlier operation. */
  readonly reattached: boolean;
}

export type RemoteAgentAgentOperationRunner = (
  operation: RemoteAgentAgentOperation,
) => Promise<RemoteAgentAgentOutcome>;

/** Mirrors the owner's single-frame bound so callers fail before the wire. */
export const REMOTE_AGENT_AGENT_ARTIFACT_LIMIT_BYTES = 48 * 1024;
export const REMOTE_AGENT_AGENT_OPERATION_ID_BYTES = 32;
const MIN_OPERATION_ID_BYTES = 16;
const MAX_OPERATION_ID_BYTES = 64;
const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const SAFE_SHA256 = /^[a-f0-9]{64}$/;

export function isRemoteAgentArtifactAction(
  action: RemoteAgentAgentAction,
): action is RemoteAgentArtifactAction {
  return action === "install" || action === "update";
}

/** Fail closed on any operand the owner would refuse, before dispatch. */
export function validateRemoteAgentAgentOperation(operation: RemoteAgentAgentOperation): void {
  const valid = (REMOTE_AGENT_AGENT_ACTIONS as readonly string[]).includes(operation.action);
  const id = operation.operationId;
  if (
    !valid ||
    !operation.executionTargetId ||
    id.length < MIN_OPERATION_ID_BYTES ||
    id.length > MAX_OPERATION_ID_BYTES
  ) {
    throw new Error("Invalid remote agent operation.");
  }
  if (!isRemoteAgentArtifactAction(operation.action)) {
    if (operation.artifact !== undefined) {
      throw new Error("Only install and update accept remote agent artifact bytes.");
    }
    return;
  }
  const artifact = operation.artifact;
  if (
    !artifact ||
    !SAFE_LABEL.test(artifact.version) ||
    artifact.version.length > 64 ||
    !SAFE_LABEL.test(artifact.targetTriple) ||
    artifact.targetTriple.length > 64 ||
    !SAFE_SHA256.test(artifact.sha256) ||
    !Number.isSafeInteger(artifact.size) ||
    artifact.size < 1 ||
    artifact.size > REMOTE_AGENT_AGENT_ARTIFACT_LIMIT_BYTES ||
    artifact.bytes.length !== artifact.size
  ) {
    throw new Error("Invalid remote agent artifact identity.");
  }
}

/**
 * Run one typed agent operation and preserve the diagnosed-command contract:
 * bounded output, redacted stderr tail on failure, and a typed refusal for an
 * unconfirmed result instead of a retry.
 */
export async function runRemoteAgentAgentOperation(
  runner: RemoteAgentAgentOperationRunner,
  operation: RemoteAgentAgentOperation,
  stage: RemoteAgentCommandStage,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  validateRemoteAgentAgentOperation(operation);
  const result = await runner(operation);
  if (result.outcomeUnknown) {
    throw new RemoteAgentRemoteCommandError(
      stage,
      result.exitCode ?? null,
      true,
      sanitizeRemoteAgentStderr(result.stderr),
    );
  }
  if (result.truncated) {
    throw new RemoteAgentRemoteCommandError(
      stage,
      result.exitCode ?? null,
      false,
      "Remote output exceeded limit.",
    );
  }
  if (result.exitCode !== undefined && result.exitCode !== 0) {
    throw new RemoteAgentRemoteCommandError(
      stage,
      result.exitCode,
      false,
      sanitizeRemoteAgentStderr(result.stderr),
    );
  }
  return { stdout: result.stdout, stderr: result.stderr };
}
