import type { TerminalSessionSnapshot } from "@bigbud/contracts/workspace/terminal.ts";
import type { TerminalWslIdentity } from "@bigbud/contracts/workspace/terminal.wsl.ts";

export interface TerminalLaunchBinding {
  updatedAt?: string | undefined;
  runtimeGeneration?: string | undefined;
  wslIdentity?: TerminalWslIdentity | undefined;
  cwd: string;
  worktreePath?: string | null | undefined;
  executionTargetId?: string | undefined;
  runtimeEnv?: Record<string, string> | undefined;
}

const bindings = new Map<string, TerminalLaunchBinding>();
const listeners = new Set<() => void>();
export function subscribeTerminalLaunch(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
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

/** Events and delayed RPC responses share the same timestamp fence. */
export function isCurrentTerminalSnapshot(snapshot: TerminalSessionSnapshot): boolean {
  const previous = readTerminalLaunch(snapshot.threadId, snapshot.terminalId);
  return !previous?.updatedAt || snapshot.updatedAt >= previous.updatedAt;
}

/** The server's actual launch folder wins for future reattachments, including Home fallback. */
export function recordTerminalLaunch(snapshot: TerminalSessionSnapshot): boolean {
  const id = key(snapshot.threadId, snapshot.terminalId);
  const previous = bindings.get(id);
  if (!isCurrentTerminalSnapshot(snapshot)) return false;
  bindings.set(id, {
    ...previous,
    updatedAt: snapshot.updatedAt,
    runtimeGeneration: snapshot.runtimeGeneration,
    wslIdentity: snapshot.wslIdentity,
    cwd: snapshot.cwd,
    worktreePath: snapshot.worktreePath,
    executionTargetId: snapshot.executionTargetId,
    runtimeEnv: snapshot.runtimeEnv ? { ...snapshot.runtimeEnv } : undefined,
  });
  for (const listener of listeners) listener();
  return true;
}

export function forgetTerminalLaunch(threadId: string, terminalId: string): void {
  bindings.delete(key(threadId, terminalId));
  for (const listener of listeners) listener();
}
