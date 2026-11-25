import type { SshShellOwnerAccess } from "../ssh/sshShellRunner.owner.ts";
import type { PickerProofOwner } from "../ssh/sshOwnerPickerProof.client.ts";

interface SelectedShellSession {
  readonly kind?: string;
  readonly targetId?: string;
  readonly fixture?: { readonly folder?: string };
  readonly picker?: {
    readonly withOwner?: <A>(
      targetId: string,
      use: (owner: PickerProofOwner) => Promise<A>,
      signal?: AbortSignal,
    ) => Promise<A>;
  };
  readonly guardedWorkspace?: { readonly cwd?: string };
}

export interface SelectedOwnerAccess {
  readonly targetId: string;
  readonly workspaceRoot: string;
  readonly withOwner: <A>(
    targetId: string,
    use: (owner: PickerProofOwner) => Promise<A>,
    signal?: AbortSignal,
  ) => Promise<A>;
}

/**
 * Builds the exact selected-owner capability for one authenticated dev session.
 * A guarded, retained or ordinary unix session may use its own workspace root;
 * anything else refuses instead of falling back to legacy SSH.
 */
export function resolveSelectedOwnerAccess(session: unknown): SelectedOwnerAccess | undefined {
  const candidate = session as SelectedShellSession | undefined;
  if (
    !candidate ||
    (candidate.kind !== "unix" && candidate.kind !== "retained-unix") ||
    typeof candidate.targetId !== "string" ||
    typeof candidate.picker?.withOwner !== "function"
  ) {
    return undefined;
  }
  const workspaceRoot = candidate.guardedWorkspace?.cwd ?? candidate.fixture?.folder;
  if (!workspaceRoot) return undefined;
  return {
    targetId: candidate.targetId,
    workspaceRoot,
    withOwner: candidate.picker.withOwner,
  };
}

/** Narrow view used by the direct thread shell runner. */
export function resolveSelectedShellAccess(session: unknown): SshShellOwnerAccess | undefined {
  return resolveSelectedOwnerAccess(session);
}
