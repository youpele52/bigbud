/**
 * Refuses to let the manual copy harness (`EventLogMaintenance.copyHarness.test.ts`) open a live
 * bigbud database. The harness migrates and deletes from the file it is given, so it must only
 * ever see a copy outside every bigbud state directory.
 *
 * @module EventLogMaintenance.copyHarness.guard
 */
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

/** Real path of `path`, or of its nearest existing ancestor joined with the missing rest. */
const realOrResolved = (path: string): string => {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(realOrResolved(parent), basename(absolute));
  }
};

const isInside = (path: string, root: string) => path === root || path.startsWith(`${root}${sep}`);

/** Every bigbud state root: the default home and any configured overrides. */
export const bigbudStateRoots = (
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
): ReadonlyArray<string> =>
  [join(home, ".bigbud"), env.BIGBUD_HOME, env.T3CODE_HOME]
    .filter((root): root is string => typeof root === "string" && root.length > 0)
    .map(realOrResolved);

/** Null when `path` is safe to treat as a copy; otherwise why it is refused. */
export function refuseLiveDatabase(
  path: string,
  roots: ReadonlyArray<string> = bigbudStateRoots(),
): string | null {
  const real = realOrResolved(path);
  const root = roots.find((candidate) => isInside(real, candidate));
  if (root !== undefined) return `${real} is inside the bigbud state directory ${root}`;
  if (existsSync(join(dirname(real), "backend.lock"))) {
    return `${real} sits next to a backend.lock, so it belongs to a bigbud backend`;
  }
  return null;
}
