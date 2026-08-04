import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PtyAdapter } from "../../terminal/Services/PTY";
import { ThreadShellRunner, ThreadShellRunnerError } from "../Services/ThreadShellRunner";
import { PersistentThreadPtyShellRunner } from "./ThreadShellRunner.runner";
import {
  captureLocalRuntimePathIdentity,
  reconcileWorktreeRuntimeLeases,
} from "../../retention/worktreeRuntimeLease.ts";

export const ThreadShellRunnerLive = Layer.effect(
  ThreadShellRunner,
  Effect.gen(function* () {
    const ptyAdapter = yield* PtyAdapter;
    const sql = yield* SqlClient.SqlClient;
    yield* reconcileWorktreeRuntimeLeases(sql, "shell");
    const services = yield* Effect.services();
    const runPromise = Effect.runPromiseWith(services);
    const runner = new PersistentThreadPtyShellRunner({
      spawnPty: (input) => runPromise(ptyAdapter.spawn(input)),
      acquireLease: async ({ threadId, cwd }) => {
        const identity = await captureLocalRuntimePathIdentity(cwd);
        await runPromise(
          sql`
          INSERT INTO worktree_runtime_leases (
            lease_id, thread_id, runtime_kind, canonical_path, device, inode, acquired_at, updated_at
          ) VALUES (${`shell:${threadId}`}, ${threadId}, 'shell', ${identity.canonicalPath},
            ${identity.device}, ${identity.inode}, ${new Date().toISOString()}, ${new Date().toISOString()})
          ON CONFLICT (lease_id) DO UPDATE SET canonical_path = excluded.canonical_path,
            device = excluded.device, inode = excluded.inode, updated_at = excluded.updated_at
        `.pipe(Effect.asVoid),
        );
      },
      releaseLease: (threadId) =>
        runPromise(
          sql`DELETE FROM worktree_runtime_leases
          WHERE lease_id = ${`shell:${threadId}`}`.pipe(Effect.asVoid),
        ),
      markLeaseStarted: (threadId, processId) =>
        runPromise(
          sql`UPDATE worktree_runtime_leases SET process_id = ${processId},
            updated_at = ${new Date().toISOString()}
            WHERE lease_id = ${`shell:${threadId}`}`.pipe(Effect.asVoid),
        ),
    });

    yield* Effect.addFinalizer(() => Effect.promise(() => runner.closeAll()));

    return {
      isActive: (threadId) => Effect.sync(() => runner.isActive(threadId)),
      run: (input) =>
        Effect.tryPromise({
          try: () => runner.run(input),
          catch: (cause) =>
            new ThreadShellRunnerError({
              message:
                cause instanceof Error ? cause.message : "Failed to run shell command in PTY.",
              cause,
            }),
        }),
      closeThread: (threadId) =>
        Effect.promise(() => runner.closeThread(threadId)).pipe(Effect.asVoid),
    };
  }),
);

export { PersistentThreadPtyShellRunner };
