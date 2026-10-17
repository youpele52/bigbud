import { Effect, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { assertSavedWorktreeIdentity } from "../../git/Layers/WorktreeSavedIdentity.ts";
import { toValidationError } from "./ProviderServiceHelpers.ts";

/** Recheck immediately before native startup, including recovery after a workspace changed mid-turn. */
export const assertProviderWorktreeIdentity = Effect.fn("assertProviderWorktreeIdentity")(
  function* (threadId: string) {
    const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
    if (Option.isSome(sql))
      yield* assertSavedWorktreeIdentity(sql.value, threadId).pipe(
        Effect.mapError((cause) =>
          toValidationError("ProviderService.startSession", String(cause)),
        ),
      );
  },
);
