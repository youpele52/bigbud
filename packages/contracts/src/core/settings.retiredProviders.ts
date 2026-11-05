import { Effect } from "effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { ProviderKind } from "../orchestration/orchestration.provider";

/** Discard obsolete visibility preferences while retaining current provider choices. */
export const SettingsHiddenProviders = Schema.Array(
  Schema.Union([ProviderKind, Schema.Literal("kilocode")]),
).pipe(
  Schema.decodeTo(
    Schema.Array(ProviderKind),
    SchemaTransformation.transformOrFail({
      decode: (providers) =>
        Effect.succeed<ReadonlyArray<ProviderKind>>(
          providers.filter((provider) => provider !== "kilocode"),
        ),
      encode: (providers) => Effect.succeed(providers),
    }),
  ),
);
