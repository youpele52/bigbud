import { Effect } from "effect";
import * as Data from "effect/Data";

export class MobileGatewayProcessError extends Data.TaggedError("MobileGatewayProcessError")<{
  readonly message: string;
  readonly cause?: unknown;
  readonly repairRequired: boolean;
}> {}
/** Capture interruption, settle real cleanup uninterruptibly, and never hide an uncertain exit. */
export function settledMobileGatewayProcess<A>(run: (signal: AbortSignal) => Promise<A>) {
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const controller = new AbortController();
      const completion = Promise.resolve().then(() => run(controller.signal));
      const outcome = completion.then(
        (value) => ({ ok: true as const, value }),
        (error) => ({ ok: false as const, error: error as unknown }),
      );
      const exit = yield* Effect.exit(
        restore(
          Effect.tryPromise({
            try: (signal) => {
              const abort = () => controller.abort(signal.reason);
              signal.addEventListener("abort", abort, { once: true });
              if (signal.aborted) abort();
              return completion.finally(() => signal.removeEventListener("abort", abort));
            },
            catch: (cause) =>
              cause instanceof MobileGatewayProcessError
                ? cause
                : new MobileGatewayProcessError({
                    message: "Owned private mobile gateway process did not complete.",
                    repairRequired: false,
                    cause,
                  }),
          }),
        ),
      );
      controller.abort();
      const settled = yield* Effect.promise(() => outcome);
      if (
        !settled.ok &&
        settled.error instanceof MobileGatewayProcessError &&
        settled.error.repairRequired
      )
        return yield* Effect.fail(settled.error);
      if (exit._tag === "Failure") return yield* Effect.failCause(exit.cause);
      return exit.value;
    }),
  );
}
