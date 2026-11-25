import type { Outcome } from "./sshOwnerPickerProof.codec.outcome.ts";
import type { PickerProofOperation } from "./sshOwnerPickerProof.codec.ts";
import {
  invalid,
  PickerProofOwnerError,
  type PickerProofOwnerErrorCode,
} from "./sshOwnerPickerProof.codec.wire.ts";
import type { ProofAcpCommandResult, ProofShellResult } from "./sshOwnerPickerProof.codec.shell.ts";

export interface ThreadShellRunInput {
  readonly workspaceRoot: string;
  readonly cwd: string;
  readonly threadId: string;
  readonly command: string;
  readonly timeoutMs: number;
}

export interface ProviderWorkspaceShellRunInput {
  readonly workspaceRoot: string;
  readonly cwd: string;
  readonly provider: string;
  readonly sessionId: string;
  readonly invocationId: string;
  readonly command: string;
  readonly timeoutMs: number;
}

export interface AcpCommandRunInput {
  readonly workspaceRoot: string;
  readonly cwd: string;
}

export interface PickerProofShellClient {
  runProofThreadShell(input: ThreadShellRunInput, signal?: AbortSignal): Promise<ProofShellResult>;
  runProofProviderWorkspaceShell(
    input: ProviderWorkspaceShellRunInput,
    signal?: AbortSignal,
  ): Promise<ProofShellResult>;
  runProofAcpCommand(
    input: AcpCommandRunInput,
    signal?: AbortSignal,
  ): Promise<ProofAcpCommandResult>;
}

function abortError(): PickerProofOwnerError {
  return new PickerProofOwnerError("shellCancelled");
}

/**
 * Cancels only this operation lease. Dispatch is never replayed; an abort after
 * dispatch is reported as `shellCancelled` and the late reply is ignored.
 */
function withLeaseCancellation<A>(
  pending: Promise<A>,
  signal: AbortSignal | undefined,
  mapped: () => PickerProofOwnerError,
): Promise<A> {
  if (!signal) return pending;
  if (signal.aborted) return Promise.reject(mapped());
  return new Promise<A>((resolve, reject) => {
    const onAbort = () => reject(mapped());
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function makePickerProofShellClient(
  execute: (operation: PickerProofOperation) => Promise<Outcome>,
): PickerProofShellClient {
  const shell = async (
    operation: PickerProofOperation,
    signal: AbortSignal | undefined,
    expected: "proofThreadShell" | "proofProviderShell",
  ) => {
    const pending = execute(operation).then((outcome) =>
      outcome.kind === expected ? outcome.value : invalid(),
    );
    const result = await withLeaseCancellation(pending, signal, abortError);
    return result satisfies ProofShellResult;
  };
  return {
    runProofThreadShell(input, signal) {
      return shell({ kind: "proofRunThreadShell", ...input }, signal, "proofThreadShell");
    },
    runProofProviderWorkspaceShell(input, signal) {
      return shell(
        { kind: "proofRunProviderWorkspaceShell", ...input },
        signal,
        "proofProviderShell",
      );
    },
    async runProofAcpCommand(input, signal) {
      const pending = execute({ kind: "proofRunAcpCommand", ...input }).then((outcome) =>
        outcome.kind === "proofAcpCommand" ? outcome.value : invalid(),
      );
      return withLeaseCancellation(pending, signal, () => {
        // A cancelled ACP command must never be replayed as another operation.
        const code: PickerProofOwnerErrorCode = "shellCancelled";
        return new PickerProofOwnerError(code);
      });
    },
  };
}
