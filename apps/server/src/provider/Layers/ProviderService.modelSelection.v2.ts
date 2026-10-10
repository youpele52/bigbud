import type { ProviderSessionStartInput } from "@bigbud/contracts";
import { Effect, Schema } from "effect";
import type { ProviderRuntimeBinding } from "../Services/ProviderSessionDirectory.ts";
import { readPersistedModelSelection, toValidationError } from "./ProviderServiceHelpers.ts";

const Cursor = Schema.Struct({
  provider: Schema.Literal("opencodeV2"),
  nativeSessionId: Schema.String,
  storageIdentity: Schema.String,
  directory: Schema.String,
  model: Schema.optional(
    Schema.Struct({
      providerID: Schema.String,
      id: Schema.String,
      variant: Schema.optional(Schema.String),
    }),
  ),
});

/** Current model comes from the guarded runtime cursor, not an old admission's captured selection. */
export const readV2CursorSelection = Effect.fn("readV2CursorSelection")(function* (value: unknown) {
  const cursor = yield* Schema.decodeUnknownEffect(Cursor)(value).pipe(
    Effect.mapError(() =>
      toValidationError(
        "ProviderService.startSession",
        "V2 saved native cursor is invalid; no history was rebound.",
      ),
    ),
  );
  if (!cursor.model) return undefined;
  if (
    !cursor.model.providerID.trim() ||
    !cursor.model.id.trim() ||
    cursor.model.id === "default" ||
    (cursor.model?.variant !== undefined && !cursor.model.variant.trim())
  )
    return yield* toValidationError(
      "ProviderService.startSession",
      "V2 saved native model selection is unavailable; no history was rebound.",
    );
  return {
    provider: "opencodeV2" as const,
    subProviderID: cursor.model.providerID,
    model: cursor.model.id,
    ...(cursor.model.variant ? { options: { variant: cursor.model.variant } } : {}),
  };
});

/** Rebind the saved native selection first; the captured new turn still performs its guarded switch. */
export const restoreV2StartSelection = Effect.fn("restoreV2StartSelection")(function* (
  input: ProviderSessionStartInput,
  binding: ProviderRuntimeBinding | undefined,
  reusePersistedResumeCursor: boolean,
) {
  if (
    input.provider !== "opencodeV2" ||
    binding?.provider !== "opencodeV2" ||
    !reusePersistedResumeCursor ||
    binding.resumeCursor == null
  )
    return input.modelSelection;
  const selection =
    (yield* readV2CursorSelection(binding.resumeCursor)) ??
    readPersistedModelSelection(binding.runtimePayload);
  if (
    selection?.provider !== "opencodeV2" ||
    !selection.subProviderID?.trim() ||
    !selection.model.trim() ||
    selection.model === "default"
  )
    return yield* toValidationError(
      "ProviderService.startSession",
      "V2 saved native model selection is unavailable; no history was rebound.",
    );
  return selection;
});
