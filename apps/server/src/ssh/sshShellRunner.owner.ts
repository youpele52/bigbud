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

/** Default 30 s, ceiling 120 s; the owner applies the same bound. */
export function boundedTimeout(timeoutMs: number | null | undefined): number {
  if (timeoutMs === null || timeoutMs === undefined || timeoutMs <= 0) {
    return THREAD_SHELL_DEFAULT_TIMEOUT_MS;
  }
  return Math.max(1, Math.min(Math.floor(timeoutMs), THREAD_SHELL_MAX_TIMEOUT_MS));
}

/** Typed owner refusals as user-facing text; nothing is replayed. */
export function ownerShellError(cause: unknown): string {
  if (cause instanceof Error && "code" in cause) {
    switch ((cause as { code?: unknown }).code) {
      case "shellTimedOut":
        return "The remote shell command timed out. The owner lease was terminated and the command was not replayed.";
      case "shellCancelled":
        return "The remote shell command was cancelled for this thread. It was not replayed.";
      case "outcomeUnknown":
        return "The remote shell outcome is unknown. The command was not replayed.";
      case "workspacePathDenied":
        return "The remote shell workspace or cwd was refused by the owner.";
      case "ownerUnavailable":
        return "The SSH owner is unavailable. No legacy shell was started.";
      case "sessionQuota":
        return "Too many remote shell commands are running on this SSH target. No command was started.";
    }
  }
  return cause instanceof Error ? cause.message : "Failed to run shell command over the SSH owner.";
}
