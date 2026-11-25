import type { PickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import type { ProofShellResult } from "./sshOwnerPickerProof.codec.shell.ts";

/** Exact selected-owner capability for one authorized development workspace. */
export interface SshShellOwnerAccess {
  readonly targetId: string;
  readonly workspaceRoot: string;
  /** Only the already-authenticated owner session for this exact target. */
  readonly withOwner: <A>(
    targetId: string,
    use: (owner: PickerProofOwner) => Promise<A>,
    signal?: AbortSignal,
  ) => Promise<A>;
}

export interface SshShellOwnerClient {
  runProofThreadShell(
    input: {
      readonly workspaceRoot: string;
      readonly cwd: string;
      readonly threadId: string;
      readonly command: string;
      readonly timeoutMs: number;
    },
    signal?: AbortSignal,
  ): Promise<ProofShellResult>;
}

export const THREAD_SHELL_DEFAULT_TIMEOUT_MS = 30_000;
export const THREAD_SHELL_MAX_TIMEOUT_MS = 120_000;
export const THREAD_SHELL_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export function truncateShellOutput(output: string): {
  readonly output: string;
  readonly truncated: boolean;
} {
  const bytes = Buffer.from(output, "utf8");
  if (bytes.byteLength <= THREAD_SHELL_MAX_OUTPUT_BYTES) return { output, truncated: false };
  return {
    output: bytes.subarray(0, THREAD_SHELL_MAX_OUTPUT_BYTES).toString("utf8"),
    truncated: true,
  };
}
