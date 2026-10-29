import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";

import { Effect, Option } from "effect";

import { PtySpawnError, type PtySpawnInput } from "../Services/PTY";
import { makeBoundedShellFileCheck } from "./PtyShellExecutable.pending";

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    if (!(await stat(candidate)).isFile()) return false;
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const checkExecutableFile = makeBoundedShellFileCheck(isExecutableFile);

/** A check that has not answered by then lets the spawn proceed (fail open). */
export const LOCAL_SHELL_CHECK_TIMEOUT_MS = 1_000;

/**
 * Whether a local POSIX shell can be executed. node-pty's spawn helper reports a missing or
 * non-executable shell as an immediate exit with code 1 rather than a spawn error, which would
 * bypass the manager's shell fallback chain, so local adapters check before spawning.
 *
 * Only paths containing a slash are checked, resolved against the spawn cwd. Bare names are left
 * to the spawn's own PATH lookup: searching every PATH directory here would park a filesystem
 * worker on any entry that sits on a stalled network mount.
 */
export async function isLocalShellExecutable(input: {
  readonly shell: string;
  readonly cwd: string;
}): Promise<boolean> {
  if (input.shell.length === 0) return false;
  if (!input.shell.includes("/")) return true;
  return checkExecutableFile(path.resolve(input.cwd, input.shell));
}

/** Fails with a retryable `PtySpawnError` when a local POSIX shell cannot be executed. */
export const ensureLocalShellExecutable = (
  adapter: string,
  input: Pick<PtySpawnInput, "shell" | "cwd">,
  timeoutMs = LOCAL_SHELL_CHECK_TIMEOUT_MS,
  check: typeof isLocalShellExecutable = isLocalShellExecutable,
): Effect.Effect<void, PtySpawnError> =>
  process.platform === "win32"
    ? Effect.void
    : Effect.promise(() => check({ shell: input.shell, cwd: input.cwd })).pipe(
        Effect.timeoutOption(timeoutMs),
        Effect.flatMap((executable) =>
          // An unanswered check (a stalled mount) must not block or reject the spawn.
          Option.getOrElse(executable, () => true)
            ? Effect.void
            : Effect.fail(
                new PtySpawnError({
                  adapter,
                  // `ENOENT` keeps the manager's retryable-shell classification.
                  message: `ENOENT: shell not found or not executable: ${input.shell}`,
                }),
              ),
        ),
      );

export function ptySpawnErrorFromThrown(adapter: string, cause: unknown): PtySpawnError {
  return new PtySpawnError({
    adapter,
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
}
