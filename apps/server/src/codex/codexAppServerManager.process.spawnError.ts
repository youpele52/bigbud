/**
 * Node reports spawn failures (ENOENT, EACCES, EMFILE) as an `error` event on
 * `process.nextTick`. Session listeners attach only after the start is awaited,
 * so every app-server spawn site records the first error here; otherwise it
 * would be an uncaught exception. The start then rethrows it.
 *
 * @module codexAppServerManager.process.spawnError
 */
import type { ChildProcess } from "node:child_process";

const earlySpawnErrors = new WeakMap<ChildProcess, Error>();

export function recordEarlySpawnError<T extends ChildProcess>(child: T): T {
  child.once("error", (error) => {
    if (!earlySpawnErrors.has(child)) earlySpawnErrors.set(child, error);
  });
  return child;
}

export function takeEarlySpawnError(child: ChildProcess): Error | undefined {
  const error = earlySpawnErrors.get(child);
  earlySpawnErrors.delete(child);
  return error;
}
