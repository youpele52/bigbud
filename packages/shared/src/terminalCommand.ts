import { DEFAULT_TERMINAL_ID } from "@bigbud/contracts";
import { resolveExecutionTargetId } from "@bigbud/contracts/core/baseSchemas";
import type {
  TerminalOpenInput,
  TerminalSessionSnapshot,
} from "@bigbud/contracts/workspace/terminal.ts";

export interface TerminalCommandContext {
  cwd: string;
  worktreePath?: string | null | undefined;
  executionTargetId?: string | undefined;
  env?: Readonly<Record<string, string>> | undefined;
}

/** Compare launch context exactly; neither path aliases nor a shell's live pwd are inferred. */
export function terminalCommandContextMatches(
  actual: TerminalCommandContext,
  expected: TerminalCommandContext,
): boolean {
  const actualEnv = actual.env ?? {};
  const expectedEnv = expected.env ?? {};
  return (
    actual.cwd === expected.cwd &&
    (actual.worktreePath ?? null) === (expected.worktreePath ?? null) &&
    resolveExecutionTargetId(actual.executionTargetId) ===
      resolveExecutionTargetId(expected.executionTargetId) &&
    Object.keys(actualEnv).length === Object.keys(expectedEnv).length &&
    Object.entries(expectedEnv).every(
      ([key, value]) => Object.hasOwn(actualEnv, key) && actualEnv[key] === value,
    )
  );
}

/** Fail closed before writing commands into a fallback, reattached, or unverified runtime. */
export function assertTerminalCommandContext(
  snapshot: TerminalSessionSnapshot,
  expected: TerminalOpenInput,
): void {
  if (snapshot.directoryFallback) {
    throw new Error(
      `${snapshot.directoryFallback.reason}: ${snapshot.directoryFallback.requestedCwd}. The terminal started in ${snapshot.cwd}. Project commands were not run in the fallback folder.`,
    );
  }
  if (
    snapshot.threadId !== expected.threadId ||
    snapshot.terminalId !== (expected.terminalId ?? DEFAULT_TERMINAL_ID) ||
    snapshot.status !== "running" ||
    snapshot.runtimeEnv === undefined ||
    !terminalCommandContextMatches(
      {
        cwd: snapshot.cwd,
        worktreePath: snapshot.worktreePath,
        executionTargetId: snapshot.executionTargetId,
        env: snapshot.runtimeEnv,
      },
      expected,
    )
  ) {
    throw new Error(
      "The terminal launch context does not match the requested project folder, worktree, target, or environment. Project commands were not run. Open a new terminal and retry.",
    );
  }
}
