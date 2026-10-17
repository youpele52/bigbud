import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { makeSqlitePersistenceLive } from "../../../persistence/Layers/Sqlite.ts";
import { OpencodeV2SharedBindings } from "../../../persistence/Services/OpencodeV2SharedBindings.ts";
import { OpencodeV2SharedBindingsLive } from "../../../persistence/Layers/OpencodeV2SharedBindings.ts";
import { ProviderTurnAdmissions } from "../../../persistence/Services/ProviderTurnAdmissions.ts";
import { ProviderTurnAdmissionsLive } from "../../../persistence/Layers/ProviderTurnAdmissions.ts";

/** Each invocation finalizes the real migrated SQLite connection before a subsequent reopen. */
export function withV2FileRepositories<A>(
  filename: string,
  run: (repositories: {
    journal: typeof ProviderTurnAdmissions.Service;
    sharedBindings: typeof OpencodeV2SharedBindings.Service;
  }) => Promise<A>,
) {
  const layer = Layer.merge(ProviderTurnAdmissionsLive, OpencodeV2SharedBindingsLive).pipe(
    Layer.provide(makeSqlitePersistenceLive(filename)),
    Layer.provide(NodeServices.layer),
  );
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const journal = yield* ProviderTurnAdmissions;
        const sharedBindings = yield* OpencodeV2SharedBindings;
        return yield* Effect.promise(() => run({ journal, sharedBindings }));
      }).pipe(Effect.provide(layer)),
    ),
  );
}
