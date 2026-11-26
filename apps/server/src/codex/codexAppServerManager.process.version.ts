import type { CodexAppServerProcess } from "./codexAppServerManager.processHandle.ts";

const versions = new WeakMap<CodexAppServerProcess, string | undefined>();

/** Bind a fresh startup observation to this child, never to a reusable binary-path cache. */
export function bindCodexProcessVersion<T extends CodexAppServerProcess>(
  child: T,
  version: string | undefined,
): T {
  versions.set(child, version);
  return child;
}

export function readCodexProcessVersion(child: CodexAppServerProcess): string | undefined {
  return versions.get(child);
}
