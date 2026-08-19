import type { OrchestrationEvent } from "@bigbud/contracts";
import { Duration, Effect, Option, Stream } from "effect";

export type ReadModelSettleCheck<A> =
  | { readonly done: true; readonly value: A }
  | { readonly done: false };

export const waitForReadModelCondition = Effect.fn("waitForReadModelCondition")(function* <
  A,
>(input: {
  readonly check: Effect.Effect<ReadModelSettleCheck<A>>;
  readonly events: Stream.Stream<OrchestrationEvent>;
  readonly timeout: Duration.Duration;
  readonly onTimeout: A;
}) {
  const first = yield* input.check;
  if (first.done) return first.value;

  const head = yield* Stream.runHead(
    input.events.pipe(
      Stream.mapEffect(() => input.check),
      Stream.filter((result): result is { readonly done: true; readonly value: A } => result.done),
      Stream.map((result) => result.value),
    ),
  ).pipe(
    Effect.timeout(input.timeout),
    Effect.catch(() => Effect.succeed(Option.none())),
  );
  return Option.match(head, {
    onNone: () => input.onTimeout,
    onSome: (value) => value,
  });
});
