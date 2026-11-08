/**
 * Offline CLI commands that write the database hold the backend lock (`<stateDir>/backend.lock`)
 * while they run, instead of trusting a `--server-stopped` flag: acquiring it proves no live
 * backend owns the state directory, and holding it keeps one from starting mid-command.
 *
 * @module cli.backendLock
 */
import { Data, Effect } from "effect";

import { acquireStateDirLock, StateDirLockError } from "../startup/stateDirLock.ts";

export class CliBackendLockError extends Data.TaggedError("CliBackendLockError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const holdBackendLockForCli = (input: {
  readonly stateDir: string;
  readonly port: number;
  readonly command: string;
}) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () => acquireStateDirLock({ stateDir: input.stateDir, port: input.port }),
      catch: (cause) =>
        new CliBackendLockError({
          message:
            cause instanceof StateDirLockError
              ? `${input.command} --apply needs the bigbud backend stopped. ${cause.message}`
              : `${input.command} --apply could not check the bigbud backend lock in ${input.stateDir}.`,
          cause,
        }),
    }),
    (handle) => Effect.promise(() => handle.release().catch(() => undefined)),
  );
