import type { ChildProcessWithoutNullStreams } from "node:child_process";

const versions = new WeakMap<ChildProcessWithoutNullStreams, string | undefined>();

/** Bind a fresh startup observation to this child, never to a reusable binary-path cache. */
export function bindCodexProcessVersion(
  child: ChildProcessWithoutNullStreams,
  version: string | undefined,
): ChildProcessWithoutNullStreams {
  versions.set(child, version);
  return child;
}

export function readCodexProcessVersion(child: ChildProcessWithoutNullStreams): string | undefined {
  return versions.get(child);
}
