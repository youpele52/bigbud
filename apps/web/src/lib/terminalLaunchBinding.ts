import type { TerminalSessionSnapshot } from "@bigbud/contracts/workspace/terminal.ts";

export interface TerminalLaunchBinding {
  cwd: string;
  worktreePath?: string | null | undefined;
  executionTargetId?: string | undefined;
  runtimeEnv?: Record<string, string> | undefined;
}

const bindings = new Map<string, TerminalLaunchBinding>();
const key = (threadId: string, terminalId: string) => JSON.stringify([threadId, terminalId]);

/** Read an existing launch without binding a retained terminal to new chat settings. */
export function readTerminalLaunch(
  threadId: string,
  terminalId: string,
): TerminalLaunchBinding | undefined {
  return bindings.get(key(threadId, terminalId));
}

/** Launch context belongs to a terminal, never to its chat's latest workspace selection. */
export function bindTerminalLaunch(
  threadId: string,
  terminalId: string,
  context: TerminalLaunchBinding,
): TerminalLaunchBinding {
  const id = key(threadId, terminalId);
  const previous = bindings.get(id);
  if (previous) return previous;
  const binding = {
    ...context,
    ...(context.runtimeEnv ? { runtimeEnv: { ...context.runtimeEnv } } : {}),
  };
  bindings.set(id, binding);
  return binding;
}

/** The server's actual launch folder wins for future reattachments, including Home fallback. */
export function recordTerminalLaunch(snapshot: TerminalSessionSnapshot): void {
  const id = key(snapshot.threadId, snapshot.terminalId);
  const previous = bindings.get(id);
  bindings.set(id, {
    ...previous,
    cwd: snapshot.cwd,
    worktreePath: snapshot.worktreePath,
    executionTargetId: snapshot.executionTargetId,
    runtimeEnv: snapshot.runtimeEnv ? { ...snapshot.runtimeEnv } : undefined,
  });
}

export function forgetTerminalLaunch(threadId: string, terminalId: string): void {
  bindings.delete(key(threadId, terminalId));
}
