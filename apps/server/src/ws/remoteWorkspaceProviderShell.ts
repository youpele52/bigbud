import type { ProofShellResult } from "../ssh/sshOwnerPickerProof.codec.shell.ts";
import { readSshOwnerProductionOwner } from "../ssh/sshOwnerProductionRegistry.ts";
import {
  productionShellTarget,
  type ProductionOwnerSource,
} from "../ssh/sshShellRunner.production.ts";

export interface SelectedProviderWorkspaceShellInput {
  readonly workspaceRoot: string;
  readonly cwd: string;
  readonly provider: string;
  readonly sessionId: string;
  readonly invocationId: string;
  readonly command: string;
  readonly timeoutMs: number;
}

export interface SelectedProviderWorkspaceShell {
  readonly targetId: string;
  readonly workspaceRoot: string;
  run(input: SelectedProviderWorkspaceShellInput, signal?: AbortSignal): Promise<ProofShellResult>;
}

/**
 * Fixed file, search, listing and patch actions have dedicated typed workspace
 * verbs. They must never arrive through this general shell envelope.
 */
const FIXED_TOOL_COMMANDS = new Set([
  "apply_patch",
  "cat",
  "cp",
  "find",
  "grep",
  "head",
  "ls",
  "mkdir",
  "mv",
  "patch",
  "rg",
  "rm",
  "sed",
  "tail",
  "touch",
]);

export function isFixedProviderShellCommand(command: string): boolean {
  const first = command.trim().split(/\s+/, 1)[0] ?? "";
  const basename = first.slice(first.lastIndexOf("/") + 1);
  return FIXED_TOOL_COMMANDS.has(basename);
}

export const PROVIDER_SHELL_REFUSAL =
  "Fixed file, search, listing and patch actions must use the typed workspace verbs; no provider shell was dispatched.";

/**
 * W2 T-shell production source: the thread tool's authorized target and
 * workspace (the workspace binding snapshot) on the live production owner. The
 * owner is read per invocation; there is no legacy fallback.
 */
export function makeProductionProviderWorkspaceShell(
  targetId: string,
  workspaceRoot: string,
  owner: ProductionOwnerSource = readSshOwnerProductionOwner,
): SelectedProviderWorkspaceShell {
  return {
    targetId,
    workspaceRoot,
    run: async (input, signal) =>
      (await productionShellTarget(owner, targetId)).runProviderWorkspaceShell(input, signal),
  };
}
