import * as Rpc from "effect/unstable/rpc/Rpc";

import {
  DATABASE_COMPACTION_WS_METHODS,
  DatabaseCompactionEmptyInput,
  DatabaseCompactionPreview,
  DatabaseCompactionStatus,
  ServerDatabaseCompactionError,
} from "./databaseCompaction";
import { ThreadRetentionMutationAuthorization } from "./rpc.retention";

/** In-memory status; never touches the database, so it answers while `VACUUM` runs. */
export const WsServerGetDatabaseCompactionStatusRpc = Rpc.make(
  DATABASE_COMPACTION_WS_METHODS.getStatus,
  {
    payload: DatabaseCompactionEmptyInput,
    success: DatabaseCompactionStatus,
    error: ServerDatabaseCompactionError,
  },
);

/** Same trusted local presence as the thread retention actions next to it in Settings. */
export const WsServerPreviewDatabaseCompactionRpc = Rpc.make(
  DATABASE_COMPACTION_WS_METHODS.preview,
  {
    payload: DatabaseCompactionEmptyInput,
    success: DatabaseCompactionPreview,
    error: ServerDatabaseCompactionError,
  },
).middleware(ThreadRetentionMutationAuthorization);

export const WsServerStartDatabaseCompactionRpc = Rpc.make(DATABASE_COMPACTION_WS_METHODS.start, {
  payload: DatabaseCompactionEmptyInput,
  success: DatabaseCompactionStatus,
  error: ServerDatabaseCompactionError,
}).middleware(ThreadRetentionMutationAuthorization);
