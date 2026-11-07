import {
  DATABASE_COMPACTION_WS_METHODS,
  ServerDatabaseCompactionError,
} from "@bigbud/contracts/server/databaseCompaction.ts";
import { Effect, Option } from "effect";

import { observeRpcEffect } from "../observability/RpcInstrumentation.ts";
import { DatabaseCompaction } from "../persistence/Services/DatabaseCompaction.ts";

const unavailable = Effect.fail(
  new ServerDatabaseCompactionError({
    code: "unavailable",
    message: "Database compaction is not available on this server.",
  }),
);

/** Resolves the optional service itself, so the shared RPC context stays unchanged. */
export const makeWsRpcDatabaseCompactionHandlers = Effect.gen(function* () {
  const compaction = yield* Effect.serviceOption(DatabaseCompaction);
  const attributes = { "rpc.aggregate": "server" } as const;
  return {
    [DATABASE_COMPACTION_WS_METHODS.getStatus]: () =>
      observeRpcEffect(
        DATABASE_COMPACTION_WS_METHODS.getStatus,
        Option.isSome(compaction) ? compaction.value.status : unavailable,
        attributes,
      ),
    [DATABASE_COMPACTION_WS_METHODS.preview]: () =>
      observeRpcEffect(
        DATABASE_COMPACTION_WS_METHODS.preview,
        Option.isSome(compaction) ? compaction.value.preview : unavailable,
        attributes,
      ),
    [DATABASE_COMPACTION_WS_METHODS.start]: () =>
      observeRpcEffect(
        DATABASE_COMPACTION_WS_METHODS.start,
        Option.isSome(compaction) ? compaction.value.start : unavailable,
        attributes,
      ),
  };
});
