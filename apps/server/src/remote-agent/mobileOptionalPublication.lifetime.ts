import { Effect } from "effect";
import * as Data from "effect/Data";
import type { MobileOptionalPublisher } from "./mobileOptionalPublication.ts";

class MobilePublicationOperationError extends Data.TaggedError("MobilePublicationOperationError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Accepted IO settles before the provided computation exits, rather than racing layer teardown. */
export function settleOwnedMobilePublisher<A>(
  factory: (signal: AbortSignal) => {
    readonly api: MobileOptionalPublisher;
    readonly close: () => Promise<void>;
  },
  operation: (publisher: MobileOptionalPublisher, signal: AbortSignal) => Promise<A>,
) {
  return Effect.uninterruptibleMask((restore) => {
    const controller = new AbortController();
    const publisher = factory(controller.signal);
    const completion = Promise.resolve().then(() => operation(publisher.api, controller.signal));
    return restore(
      Effect.tryPromise({
        try: (signal) => {
          const abort = () => controller.abort(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
          return completion.finally(() => signal.removeEventListener("abort", abort));
        },
        catch: (cause) =>
          new MobilePublicationOperationError({
            message: "Owned mobile publication did not complete; preserve its journal and files.",
            cause,
          }),
      }),
    ).pipe(
      Effect.ensuring(
        Effect.promise(async () => {
          controller.abort();
          await completion.then(
            () => {},
            () => {},
          );
          await publisher.close();
        }),
      ),
    );
  });
}
