// Test-only backend: real ownership/control/finalization, isolated state directory from fd 3.
import { readFileSync, writeSync } from "node:fs";
import * as Effect from "effect/Effect";
import { acquireStateDirLock } from "./stateDirLock.ts";
import { createOwnershipHandoff } from "./ownershipHandoff.ts";
import { OwnershipShutdown, withOwnershipShutdown } from "./ownershipShutdown.ts";

const { stateDir } = JSON.parse(readFileSync(3, "utf8"));
const application = Effect.gen(function* () {
  const shutdown = yield* OwnershipShutdown;
  const control = yield* Effect.acquireRelease(
    Effect.promise(() => createOwnershipHandoff(stateDir, shutdown.request)),
    (control) => Effect.promise(() => control.close()),
  );
  const lock = yield* Effect.acquireRelease(
    Effect.promise(() => acquireStateDirLock({ stateDir, port: 0, control: control.control })),
    (lock) => Effect.promise(() => lock.release()),
  );
  yield* Effect.promise(() => control.attach(lock));
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      // Simulate a persistence finalizer: the lock must remain held throughout this delay.
      await new Promise((resolve) => setTimeout(resolve, 50));
      writeSync(4, "finalized\n");
    }),
  );
  writeSync(4, "ready\n");
  return yield* Effect.never;
}).pipe(Effect.scoped);
await Effect.runPromise(withOwnershipShutdown(application));
