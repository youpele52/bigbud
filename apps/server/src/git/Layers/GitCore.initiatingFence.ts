import { GitCommandError } from "@bigbud/contracts/workspace/git.errors.ts";

import { isDevSshOwnerSelected } from "../../ssh/sshOwnerDevMode.ts";
import type { ExecuteGitInput } from "../Services/GitCore.ts";

export type GitExecutionLane = "initiating" | "target";

export function isInitiatingGitTransportDisabled(lane: GitExecutionLane): boolean {
  return lane === "initiating" && isDevSshOwnerSelected();
}

export const WORKSPACE_GIT_HARDENED_CONFIG_ARGS = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
] as const;

export const initiatingGitOwnerUnavailable =
  "This operation requires a typed initiating Git transport owner in source-dev SSH owner mode. No legacy transport was started.";

export function initiatingGitDenied({
  operation,
  cwd,
}: Pick<ExecuteGitInput, "operation" | "cwd">) {
  return new GitCommandError({
    operation,
    cwd,
    command: "git",
    detail: initiatingGitOwnerUnavailable,
  });
}

// Builtins used for local workspace state. No global option parsing, aliases, extension helpers,
// or inferred URL safety. Builtins with both local and transport forms are handled separately.
const localBuiltins = new Set([
  "add",
  "branch",
  "check-ignore",
  "check-ref-format",
  "checkout",
  "clean",
  "commit",
  "commit-tree",
  "config",
  "diff",
  "for-each-ref",
  "init",
  "log",
  "ls-files",
  "merge-base",
  "read-tree",
  "reset",
  "restore",
  "rev-list",
  "rev-parse",
  "show",
  "show-ref",
  "status",
  "symbolic-ref",
  "update-ref",
  "write-tree",
]);

export function isInitiatingGitLocal(args: readonly string[]): boolean {
  // Admit only the fixed workspace read prefix and the typed tracked-push probe prefix.
  if (args[0] === "-c") {
    return (
      WORKSPACE_GIT_HARDENED_CONFIG_ARGS.every((arg, index) => args[index] === arg) &&
      (args[4] === "ls-files" || args[4] === "check-ignore")
    );
  }
  const [command, subcommand, ...operands] = args[0] === "--no-lazy-fetch" ? args.slice(1) : args;
  if (command === "remote") {
    return (
      subcommand === undefined ||
      ((subcommand === "-v" || subcommand === "--verbose") && operands.length === 0) ||
      subcommand === "get-url" ||
      (subcommand === "add" &&
        operands.length === 2 &&
        operands.every((arg) => !arg.startsWith("-")))
    );
  }
  if (command === "worktree") {
    return subcommand === "list" || subcommand === "add" || subcommand === "remove";
  }
  if (command === "merge") {
    // Only the local fast-forward merge used by selected pull. No strategy, message or rebase.
    return (
      subcommand === "--ff-only" &&
      operands.length === 1 &&
      operands[0] !== undefined &&
      !operands[0].startsWith("-") &&
      !operands[0].includes("\0")
    );
  }
  return command !== undefined && localBuiltins.has(command);
}

// A local builtin can still need a missing promisor object. Do not let Git select ANY transport
// from config or the environment in that case. This is a Git transport fence, not a process sandbox.
export const initiatingGitLocalEnv = { GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "" } as const;
