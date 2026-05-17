import { Effect, Layer } from "effect";

import { PtyAdapter } from "../../terminal/Services/PTY";
import { ThreadShellRunner, ThreadShellRunnerError } from "../Services/ThreadShellRunner";
import { PersistentThreadPtyShellRunner } from "./ThreadShellRunner.runner";

export const ThreadShellRunnerLive = Layer.effect(
  ThreadShellRunner,
  Effect.gen(function* () {
    const ptyAdapter = yield* PtyAdapter;
    const services = yield* Effect.services();
    const runPromise = Effect.runPromiseWith(services);
    const runner = new PersistentThreadPtyShellRunner({
      spawnPty: (input) => runPromise(ptyAdapter.spawn(input)),
    });

    yield* Effect.addFinalizer(() => Effect.promise(() => runner.closeAll()));

    return {
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
