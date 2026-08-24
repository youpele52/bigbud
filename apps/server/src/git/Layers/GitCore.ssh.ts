import { Effect } from "effect";

import { GitCommandError } from "@bigbud/contracts/workspace/git.errors.ts";

import { runSshCommand } from "../../ssh/sshProcess.ts";
import { type ExecuteGitInput, type ExecuteGitResult } from "../Services/GitCore.ts";
import { quoteGitCommand } from "./GitCoreUtils.ts";
import { DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_TIMEOUT_MS } from "./GitCoreExecutor.ts";

const READ_ONLY_COMMANDS = new Set([
  "cat-file",
  "check-ignore",
  "diff",
  "for-each-ref",
  "log",
  "ls-files",
  "rev-list",
  "rev-parse",
  "show",
  "show-ref",
  "status",
]);

function isReadOnlyBranchCommand(args: ReadonlyArray<string>): boolean {
  if (args.length === 2 && args[1] === "--show-current") return true;
  if (!args.includes("--list")) {
    return (
      (args.length === 3 && args[1] === "--no-color" && args[2] === "--no-column") ||
      (args.length === 4 &&
        args[1] === "--no-color" &&
        args[2] === "--no-column" &&
        args[3] === "--remotes")
    );
  }
  return (
    args.length === 5 &&
    args[1] === "--list" &&
    args[2] === "--no-column" &&
    args[3]?.startsWith("--format=") === true
  );
}

function isReadOnlyConfigCommand(args: ReadonlyArray<string>): boolean {
  const options = args.slice(1);
  const [first] = options;
  if (["--get", "--get-all", "--get-regexp"].includes(first ?? "")) {
    return options.length === 2 || (options.length === 3 && options[2] === "--show-origin");
  }
  return (
    options.some((option) => option === "--list" || option === "-l") &&
    options.every((option) => ["--list", "-l", "--show-origin"].includes(option))
  );
}

function isReadOnlySymbolicRefCommand(args: ReadonlyArray<string>): boolean {
  const values = args.slice(1);
  const references = values.filter((value) => !value.startsWith("-"));
  return (
    references.length === 1 &&
    values.every((value) => !value.startsWith("-") || ["--quiet", "-q", "--short"].includes(value))
  );
}

function isReadOnlyGitCommand(args: ReadonlyArray<string>): boolean {
  const [command = ""] = args;
  if (READ_ONLY_COMMANDS.has(command)) return true;
  if (command === "branch") return isReadOnlyBranchCommand(args);
  if (command === "config") return isReadOnlyConfigCommand(args);
  if (command === "symbolic-ref") return isReadOnlySymbolicRefCommand(args);
  if (command === "remote") {
    return (
      args.length === 1 ||
      (args.length === 2 && args[1] === "-v") ||
      (args.length === 3 && ["get-url", "show"].includes(args[1] ?? ""))
    );
  }
  return (
    command === "worktree" &&
    (args.length === 2 || args.length === 3) &&
    args[1] === "list" &&
    (args.length === 2 || args[2] === "--porcelain")
  );
}

function safeEnvironment(input: ExecuteGitInput): Record<string, string> {
  const environment: Record<string, string> = {
    GIT_TERMINAL_PROMPT: "0",
  };
  const allowedNames = new Set([
    "COLUMNS",
    "GIT_ASKPASS",
    "GIT_CONFIG",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_NOSYSTEM",
    "GIT_SSH_COMMAND",
    "HOME",
    "PATH",
    "SSH_AUTH_SOCK",
    "XDG_CONFIG_HOME",
  ]);
  for (const [name, value] of Object.entries(input.env ?? {})) {
    if (
      typeof value === "string" &&
      (allowedNames.has(name) ||
        /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(name) ||
        /^GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL|DATE)$/.test(name))
    ) {
      environment[name] = value;
    }
  }
  return environment;
}

function unsupportedMutation(input: ExecuteGitInput): GitCommandError {
  return new GitCommandError({
    operation: input.operation,
    command: quoteGitCommand(input.args),
    cwd: input.cwd,
    detail:
      "Direct SSH Git fallback supports read-only operations only; install the remote agent for Git mutations.",
  });
}

export function makeSshGitExecutor() {
  return (input: ExecuteGitInput): Effect.Effect<ExecuteGitResult, GitCommandError> => {
    if (!input.executionTargetId) {
      return Effect.fail(
        new GitCommandError({
          operation: input.operation,
          command: quoteGitCommand(input.args),
          cwd: input.cwd,
          detail: "A remote Git execution target is required.",
        }),
      );
    }
    if (!isReadOnlyGitCommand(input.args)) {
      return Effect.fail(unsupportedMutation(input));
    }

    return Effect.tryPromise({
      try: () =>
        runSshCommand({
          executionTargetId: input.executionTargetId,
          cwd: input.cwd,
          command: "git",
          args: input.args,
          env: safeEnvironment(input),
          ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
          ...(input.allowNonZeroExit !== undefined
            ? { allowNonZeroExit: input.allowNonZeroExit }
            : {}),
          timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          maxBufferBytes: input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
          outputMode: input.truncateOutputAtMaxBytes ? "truncate" : "error",
        }),
      catch: (cause) =>
        new GitCommandError({
          operation: input.operation,
          command: quoteGitCommand(input.args),
          cwd: input.cwd,
          detail: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    }).pipe(
      Effect.map(
        (result): ExecuteGitResult => ({
          code: result.code ?? -1,
          stdout: result.stdout,
          stderr: result.stderr,
          stdoutTruncated: result.stdoutTruncated ?? false,
          stderrTruncated: result.stderrTruncated ?? false,
        }),
      ),
    );
  };
}
