import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

export class BackendCliError extends Data.TaggedError("BackendCliError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Accepted IO settles before the CLI scope releases, including on interruption. */
export function backendCliOwned<A>(operation: (signal: AbortSignal) => Promise<A>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const controller = new AbortController();
      const completion = Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return operation(controller.signal);
      });
      return { controller, completion };
    }),
    ({ completion }) =>
      Effect.tryPromise({
        try: () => completion,
        catch: (cause) =>
          new BackendCliError({
            message: "Backend operation did not complete; inspect its state before retrying.",
            cause,
          }),
      }),
    ({ controller, completion }) =>
      Effect.promise(async () => {
        controller.abort();
        await completion.catch(() => undefined);
      }),
  );
}
