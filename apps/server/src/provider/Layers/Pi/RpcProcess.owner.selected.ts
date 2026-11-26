import { Effect, Schema } from "effect";

/** The production owner could not hand over its typed Pi port. */
export class SelectedPiOwnerError extends Schema.TaggedErrorClass<SelectedPiOwnerError>()(
  "SelectedPiOwnerError",
  {
    message: Schema.String,
    cause: Schema.Defect,
  },
) {}

/**
 * The Pi owner for one remote runtime target: the live production owner bound to this exact
 * target. The production module is loaded lazily so a local-only graph never loads it.
 */
export const selectedPiRpcOwner = Effect.fn("selectedPiRpcOwner")(function* (
  executionTargetId: string,
) {
  const { resolveProductionPiRpcOwner } = yield* Effect.promise(
    () => import("./RpcProcess.owner.production.ts"),
  );
  return yield* Effect.tryPromise({
    try: () => resolveProductionPiRpcOwner(executionTargetId),
    catch: (cause) =>
      new SelectedPiOwnerError({
        message: "Failed to bind the production SSH owner for Pi.",
        cause,
      }),
  });
});
