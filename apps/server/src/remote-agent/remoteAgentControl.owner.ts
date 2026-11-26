import { createHash, randomBytes } from "node:crypto";
import { connect, type Socket } from "node:net";

import type {
  AgentControlOperands,
  AgentControlState,
} from "../ssh/sshOwnerPickerProof.codec.agentControl.ts";
import type { SshOwnerProductionRegistration } from "../ssh/sshOwnerProductionRegistry.ts";
import type { RemoteAgentControlOp } from "./remoteAgentControl.ops.ts";
import type { RemoteAgentInstallControlOp } from "./remoteAgentControl.ops.install.ts";
import {
  RemoteAgentRemoteCommandError,
  runRemoteAgentDiagnosedCommand,
  type RemoteAgentCommandStage,
} from "./remoteAgentDiagnostics.ts";

/**
 * U25 production remote-agent control. Every legacy control script runs as one typed
 * `agent_control` lease on the live Rust owner for the exact target: the owner compiles the
 * template generated from the legacy builder, so no script text leaves this process. The live
 * owner is read per operation; an absent owner or unresolvable target is refused before any
 * dispatch, and there is no legacy fallback. A dispatched lease without a confirmed result is
 * reported as a timed-out command and is never replayed.
 */
export type RemoteAgentOwnerOp = RemoteAgentControlOp | RemoteAgentInstallControlOp;

export interface RemoteAgentOwnerControlDependencies {
  readonly owner: () => SshOwnerProductionRegistration | undefined;
  /** Status poll bounds; tests shorten them. */
  readonly pollMs?: { readonly first: number; readonly max: number };
}

export type RemoteAgentOwnerBound = ReturnType<SshOwnerProductionRegistration["handle"]["target"]>;

/** Wait beyond the owner's own deadline (10 min for removal) before calling it unconfirmed. */
const WAIT_MS = 11 * 60 * 1000;
const UNCONFIRMED = "The SSH owner could not confirm this remote agent step; it was not replayed.";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export function remoteAgentOwnerStage(op: RemoteAgentOwnerOp): RemoteAgentCommandStage {
  switch (op.kind) {
    case "platformProbe":
      return "platform";
    case "readOnlyStatus":
    case "placedProbe":
      return "preflight";
    case "installUpload":
    case "inboxAdopt":
      return "install";
    case "identityCheck":
    case "binaryCheck":
      return "check";
    default:
      return "control";
  }
}

/** Operands and streamed bytes for one operation; nothing here is shell text. */
export function remoteAgentOwnerOperands(op: RemoteAgentOwnerOp): {
  readonly operands: AgentControlOperands;
  readonly input?: Uint8Array;
} {
  switch (op.kind) {
    case "registryCas": {
      const expected = op.expected === null ? null : Buffer.from(op.expected);
      const next = Buffer.from(op.next);
      return {
        operands: {
          kind: "registryCas",
          expected: expected && { size: expected.length, sha256: sha256(expected) },
          next: { size: next.length, sha256: sha256(next) },
        },
        input: Buffer.concat([expected ?? Buffer.alloc(0), next]),
      };
    }
    case "stageFenceRevoke":
      return { operands: { kind: op.kind, reservationId: op.reservationId } };
    case "supervisorObserve":
      return {
        operands: {
          kind: op.kind,
          runtime: op.runtime,
          observeMode: op.mode,
          attemptId: op.attemptId,
        },
      };
    case "admissionDeathObserve":
      return {
        operands: { kind: op.kind, runtime: op.runtime, attemptId: op.attemptId, epoch: op.epoch },
      };
    case "isolatedLaunch":
      return { operands: { kind: op.kind, runtime: op.runtime, attemptId: op.attemptId } };
    case "replacementLaunch":
      return {
        operands: {
          kind: op.kind,
          runtime: op.runtime,
          attemptId: op.attemptId,
          oldEpoch: op.oldEpoch,
          oldAttemptId: op.oldAttemptId,
        },
      };
    case "stateAbsent":
    case "supervisorShutdown":
    case "supervisorRestart":
    case "retirementDelete":
    case "socketLive":
    case "socketGone":
      return { operands: { kind: op.kind, runtime: op.runtime } };
    case "removal":
      return { operands: { kind: op.kind, fenceId: op.fenceId } };
    case "orphanDelete":
      return { operands: { kind: op.kind, version: op.version, sha256: op.digest } };
    case "runtimeProbe":
      return {
        operands: { kind: op.kind, ...(op.binaryPath ? { binaryPath: op.binaryPath } : {}) },
      };
    case "installUpload":
    case "inboxAdopt": {
      const { version, sha256: digest, sizeBytes } = op.artifact;
      const operands: AgentControlOperands = {
        kind: op.kind,
        version,
        sha256: digest,
        size: sizeBytes,
        ...(op.reservationId === null ? {} : { reservationId: op.reservationId }),
      };
      return op.kind === "installUpload" ? { operands, input: op.bytes } : { operands };
    }
    case "placedProbe":
      return {
        operands: {
          kind: op.kind,
          version: op.artifact.version,
          sha256: op.artifact.sha256,
          size: op.artifact.sizeBytes,
        },
      };
    case "binaryCheck":
      return {
        operands: {
          kind: "identityCheck",
          ...(op.binaryPath ? { binaryPath: op.binaryPath } : {}),
        },
      };
    case "identityCheck":
      return {
        operands: { kind: op.kind, version: op.artifact.version, sha256: op.artifact.sha256 },
      };
    default:
      return { operands: { kind: op.kind } };
  }
}

/** Bind the live owner to this exact target; refused before any dispatch otherwise. */
export async function bindRemoteAgentOwnerTarget(
  dependencies: RemoteAgentOwnerControlDependencies,
  executionTargetId: string,
): Promise<RemoteAgentOwnerBound> {
  const live = dependencies.owner();
  if (!live) throw new Error("The SSH owner is not running. Nothing was sent to the host.");
  const descriptor = await live.descriptorFor(executionTargetId).catch(() => undefined);
  if (!descriptor) throw new Error("The SSH owner could not resolve this host. Nothing was sent.");
  return live.handle.target(descriptor);
}

/** Send the lease input. The host may stop reading early (a refusal); its exit decides. */
async function stream(socketPath: string, input: Uint8Array): Promise<void> {
  const socket: Socket = await new Promise((resolve, reject) => {
    const candidate = connect({ path: socketPath, allowHalfOpen: true });
    candidate.once("connect", () => resolve(candidate));
    candidate.once("error", reject);
  });
  await new Promise<void>((resolve) => {
    socket.once("error", () => resolve());
    socket.end(input, () => resolve());
  });
  socket.destroy();
}

async function drive(
  bound: RemoteAgentOwnerBound,
  opened: AgentControlState,
  input: Uint8Array | undefined,
  poll: { readonly first: number; readonly max: number },
): Promise<AgentControlState> {
  const { lease } = opened;
  const deadline = Date.now() + WAIT_MS;
  let state = opened;
  if (input) {
    if (state.phase !== "listening") return state;
    await stream(state.socketPath, input);
  }
  let wait = poll.first;
  while (state.phase === "listening" || state.phase === "running") {
    if (Date.now() > deadline) {
      await bound.cancelAgentControl(lease).catch(() => undefined);
      return { lease, kind: opened.kind, phase: "outcomeUnknown" };
    }
    await new Promise((resolve) => setTimeout(resolve, wait));
    wait = Math.min(wait * 2, poll.max);
    state = await bound.agentControlStatus(lease);
  }
  return state;
}

/**
 * Run one operation on the owner and return its output under the legacy diagnosed-command
 * contract: a non-zero exit keeps its redacted stderr tail, and an unconfirmed outcome is a
 * timed-out command that the caller must not replay.
 */
export function makeRemoteAgentOwnerExec(
  dependencies: RemoteAgentOwnerControlDependencies,
  executionTargetId: string,
) {
  const poll = dependencies.pollMs ?? { first: 25, max: 500 };
  return async (op: RemoteAgentOwnerOp) => {
    const stage = remoteAgentOwnerStage(op);
    const { operands, input } = remoteAgentOwnerOperands(op);
    const bound = await bindRemoteAgentOwnerTarget(dependencies, executionTargetId);
    // A refusal from the open itself proves nothing ran; it propagates as is.
    const opened = await bound.openAgentControl(randomBytes(32), operands);
    const state = await drive(bound, opened, input, poll).catch(() => undefined);
    if (state?.phase !== "exited")
      throw new RemoteAgentRemoteCommandError(stage, null, true, UNCONFIRMED);
    return runRemoteAgentDiagnosedCommand(async () => ({ ...state, code: state.exitCode }), stage, {
      executionTargetId,
      command: "agent_control",
    });
  };
}
