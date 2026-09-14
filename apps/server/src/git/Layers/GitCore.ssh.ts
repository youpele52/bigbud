import { Effect } from "effect";

import { GitCommandError } from "@bigbud/contracts/workspace/git.errors.ts";

import { runSshCommand } from "../../ssh/sshProcess.ts";
import { type ExecuteGitInput, type ExecuteGitResult } from "../Services/GitCore.ts";
import { quoteGitCommand } from "./GitCoreUtils.ts";
import { DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_TIMEOUT_MS } from "./GitCoreExecutor.ts";

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
