import { Effect, Schema } from "effect";

class CliProxyActivationEffectError extends Schema.TaggedErrorClass<CliProxyActivationEffectError>()(
  "CliProxyActivationEffectError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export function toError(cause: unknown): CliProxyActivationEffectError {
  return Schema.is(CliProxyActivationEffectError)(cause)
    ? cause
    : new CliProxyActivationEffectError({
        detail: cause instanceof Error ? cause.message : "CLIProxyAPI activation failed.",
        cause,
      });
}

export function makeCoalescedPromiseEffect<A>(operation: () => Effect.Effect<A, Error>) {
  let inFlight: Promise<A> | undefined;
  return () => {
    if (inFlight) {
      return Effect.tryPromise({
        try: () => inFlight!,
        catch: toError,
      });
    }
    const promise = Effect.runPromise(operation()).finally(() => {
      inFlight = undefined;
    });
    inFlight = promise;
    return Effect.tryPromise({
      try: () => promise,
      catch: toError,
    });
  };
}
