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
  "symbolic-ref",
]);

function isReadOnlyGitCommand(args: ReadonlyArray<string>): boolean {
  const [command = ""] = args;
  if (READ_ONLY_COMMANDS.has(command)) {
    return true;
  }

  if (command === "branch") {
    return !args.some((arg) => ["-c", "-C", "-d", "-D", "-m", "-M"].includes(arg));
  }

  if (command === "config") {
    return args.some((arg) =>
      ["--get", "--get-all", "--get-regexp", "--list", "-l", "--show-origin"].includes(arg),
    );
  }

  if (command === "remote") {
    return args.some((arg) => ["-v", "get-url", "show"].includes(arg));
  }

  return command === "worktree" && args.includes("list");
}

function safeEnvironment(input: ExecuteGitInput): Record<string, string> {
  const environment: Record<string, string> = {
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const [name, value] of Object.entries(input.env ?? {})) {
    if (typeof value === "string" && /^(GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL|DATE))$/.test(name)) {
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
