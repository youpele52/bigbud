import { Cause, Option, Schema } from "effect";
import { TextGenerationError } from "@bigbud/contracts/workspace/git.errors.ts";

/** Typed uncertainty survives adapter boundaries without relying on diagnostic wording. */
export function uncertainTextGenerationError(
  cause: Cause.Cause<unknown>,
): TextGenerationError | undefined {
  const error = Cause.findErrorOption(cause);
  return Option.isSome(error) &&
    Schema.is(TextGenerationError)(error.value) &&
    error.value.kind === "uncertain"
    ? error.value
    : undefined;
}
