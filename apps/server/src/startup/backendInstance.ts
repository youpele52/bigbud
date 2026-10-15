/**
 * BackendInstance - the live backend that holds `<stateDir>/backend.lock`.
 *
 * Holding the lock proves no other live backend owns state under `stateDir`, so durable state
 * written by a different backend instance belongs to a dead backend. `assertHeld` re-reads the
 * lock immediately before such a conclusion: a deleted, replaced or unreadable lock disproves it.
 *
 * @module backendInstance
 */
import * as fs from "node:fs/promises";

import { Effect, Layer, ServiceMap } from "effect";

import { ServerConfig } from "./config.ts";
import {
  acquireStateDirLock,
  classifyStateDirLockOwner,
  defaultStateDirLockProbe,
  parseStateDirLockRecord,
  StateDirLockError,
  type StateDirLockHandle,
  type StateDirLockProbe,
} from "./stateDirLock.ts";

export interface BackendInstanceShape {
  /** Random per-acquisition lock nonce; identifies this backend instance in durable records. */
  readonly nonce: string;
  readonly pid: number;
  readonly startedAt: string | null;
  readonly hostname: string;
  readonly stateDir: string;
  readonly lockPath: string;
  /** Rejects unless the lock file still carries this instance's nonce, pid and host. */
  readonly assertHeld: () => Promise<void>;
  /** Liveness of another recorded backend process, with the lock's proof rules. */
  readonly classifyOwner: (owner: {
    readonly pid: number;
    readonly startedAt: string | null;
    readonly hostname: string;
  }) => "live" | "dead" | "foreign-host";
}

export class BackendInstance extends ServiceMap.Service<BackendInstance, BackendInstanceShape>()(
  "bigbud/startup/BackendInstance",
) {}

export function makeBackendInstance(
  handle: StateDirLockHandle,
  stateDir: string,
  probe: StateDirLockProbe = defaultStateDirLockProbe,
): BackendInstanceShape {
  const { record } = handle;
  return {
    nonce: record.nonce,
    pid: record.pid,
    startedAt: record.startedAt,
    hostname: record.hostname,
    stateDir,
    lockPath: handle.lockPath,
    assertHeld: async () => {
      const raw = await fs.readFile(handle.lockPath, "utf8").catch(() => undefined);
      const current = raw === undefined ? undefined : parseStateDirLockRecord(raw);
      if (
        !current ||
        current.nonce !== record.nonce ||
        current.pid !== record.pid ||
        current.hostname !== record.hostname
      )
        throw new Error("The bigbud backend lock is no longer held by this process.");
    },
    classifyOwner: (owner) =>
      classifyStateDirLockOwner(
        { ...record, pid: owner.pid, startedAt: owner.startedAt, hostname: owner.hostname },
        probe,
      ),
  };
}

/** Held for the server layer's lifetime; built before HTTP listening and persistence, and
 * released after both close. Provides the holder's identity to providers. */
export const StateDirLockLive = Layer.effect(
  BackendInstance,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const handle = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => acquireStateDirLock({ stateDir: config.stateDir, port: config.port }),
        catch: (cause) =>
          cause instanceof StateDirLockError
            ? cause
            : new StateDirLockError({
                stateDir: config.stateDir,
                message: `Could not acquire the bigbud backend lock in ${config.stateDir}.`,
                cause,
              }),
      }),
      (handle) => Effect.promise(() => handle.release().catch(() => {})),
    );
    return makeBackendInstance(handle, config.stateDir);
  }),
);
