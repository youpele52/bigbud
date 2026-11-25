import { posix } from "node:path";
import { Readable } from "node:stream";

import type { PickerProofTerminalClient } from "../ssh/sshOwnerPickerProof.client.terminal.ts";
import type { PickerProofShellClient } from "../ssh/sshOwnerPickerProof.client.shell.ts";
import {
  AcpTerminalOwnerError,
  type AcpOwnerCommand,
  type AcpTerminalSshOwner,
} from "./remoteWorkspaceAcpTerminal.owner.ts";

export interface AcpTerminalCwdObservation {
  readonly kind: "cwd-observation";
  /** A fresh, finite result for this approval. EOF is not a remote process exit. */
  readonly output: Readable;
}

export interface AcpTerminalCwdObserver {
  /** Trusted dispatch only, after validating and consuming the one-time launch approval. */
  readonly observeAcpCwd: (
    approved: AcpOwnerCommand,
    signal: AbortSignal,
  ) => Promise<AcpTerminalCwdObservation>;
}

type ProofCwdClient = Pick<PickerProofTerminalClient, "probeProofTerminalCwd">;
type ProofAcpCommandClient = Pick<PickerProofShellClient, "runProofAcpCommand">;

interface AcpTerminalCwdProofOptions {
  readonly targetId: string;
  readonly workspaceRoot: string;
  /** Supplies the existing private owner session for exactly this fixture target and root. */
  readonly withOwner: <A>(
    targetId: string,
    use: (owner: ProofCwdClient) => Promise<A>,
  ) => Promise<A>;
}

interface AcpTerminalCommandProofOptions {
  readonly targetId: string;
  readonly workspaceRoot: string;
  readonly withOwner: <A>(
    targetId: string,
    use: (owner: ProofAcpCommandClient) => Promise<A>,
    signal?: AbortSignal,
  ) => Promise<A>;
}

function validatedCwd(approved: AcpOwnerCommand, targetId: string, workspaceRoot: string): string {
  if (approved.operation !== "print-working-directory") {
    throw new AcpTerminalOwnerError("unsupported-command");
  }
  if (approved.executionTargetId !== targetId) {
    throw new AcpTerminalOwnerError("unsupported-target");
  }
  const { cwd } = approved;
  if (
    approved.workspaceRoot !== workspaceRoot ||
    workspaceRoot === "/" ||
    !posix.isAbsolute(cwd) ||
    posix.normalize(cwd) !== cwd ||
    cwd.endsWith("/") ||
    cwd.includes("\0") ||
    Buffer.byteLength(cwd) > 4096 ||
    (cwd !== workspaceRoot && !cwd.startsWith(`${workspaceRoot}/`))
  ) {
    throw new AcpTerminalOwnerError("unsupported-cwd");
  }
  return cwd;
}

export function makeAcpTerminalCwdProofObserver({
  targetId,
  workspaceRoot,
  withOwner,
}: AcpTerminalCwdProofOptions): AcpTerminalCwdObserver {
  return {
    async observeAcpCwd(approved, signal) {
      signal.throwIfAborted();
      const cwd = validatedCwd(approved, targetId, workspaceRoot);

      const observed = await withOwner(targetId, (owner) => {
        // Admission may have waited in the shared owner's queue. Do not start a stale probe.
        signal.throwIfAborted();
        return owner.probeProofTerminalCwd(cwd);
      });
      // The probe is bounded by the existing session. Abort suppresses a late result without
      // closing the shared owner or pretending the observation is a cancellable process.
      signal.throwIfAborted();
      // The session correlates the reply to the request, owner epoch and target generation.
      // Rust verifies physical path equality; a different path is never an acceptable result.
      if (observed !== cwd) throw new AcpTerminalOwnerError("unsupported-cwd");
      return {
        kind: "cwd-observation",
        output: Readable.from([Buffer.from(`${observed}\n`, "utf8")], { objectMode: false }),
      };
    },
  };
}

/**
 * Approved direct ACP command route. The owner-selected fixed recipe runs
 * non-interactively with no stdin, PTY, local program, environment or SSH
 * option. Output and a confirmed exit are returned as a settled lease; abort
 * cancels only this acquisition and never replays the command.
 */
export function makeAcpTerminalCommandProofOwner({
  targetId,
  workspaceRoot,
  withOwner,
}: AcpTerminalCommandProofOptions): AcpTerminalSshOwner {
  return {
    async runAcpCommand(approved, acquisitionSignal) {
      acquisitionSignal.throwIfAborted();
      const cwd = validatedCwd(approved, targetId, workspaceRoot);
      const result = await withOwner(
        targetId,
        (owner) => {
          acquisitionSignal.throwIfAborted();
          return owner.runProofAcpCommand({ workspaceRoot, cwd }, acquisitionSignal);
        },
        acquisitionSignal,
      );
      acquisitionSignal.throwIfAborted();
      if (result.truncated || result.output !== `${cwd}\n`) {
        throw new AcpTerminalOwnerError("unsupported-cwd");
      }
      return {
        output: Readable.from([Buffer.from(result.output, "utf8")], { objectMode: false }),
        exit: Promise.resolve({ kind: "exited", code: result.exitCode }),
        cancel: async () => undefined,
      };
    },
  };
}
