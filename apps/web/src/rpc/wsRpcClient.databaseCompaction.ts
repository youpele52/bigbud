import { DATABASE_COMPACTION_WS_METHODS } from "@bigbud/contracts/server/databaseCompaction.ts";

import type { RpcUnaryMethod } from "./wsRpcClient.types";
import type { WsTransport } from "./wsTransport";

/** Settings > Threads > "Compact database": status, preview and the confirmed start. */
export interface DatabaseCompactionRpcMethods {
  readonly getDatabaseCompactionStatus: RpcUnaryMethod<
    typeof DATABASE_COMPACTION_WS_METHODS.getStatus
  >;
  readonly previewDatabaseCompaction: RpcUnaryMethod<typeof DATABASE_COMPACTION_WS_METHODS.preview>;
  readonly startDatabaseCompaction: RpcUnaryMethod<typeof DATABASE_COMPACTION_WS_METHODS.start>;
}

export function createDatabaseCompactionRpcMethods(
  transport: WsTransport,
): DatabaseCompactionRpcMethods {
  return {
    getDatabaseCompactionStatus: (input) =>
      transport.request((client) => client[DATABASE_COMPACTION_WS_METHODS.getStatus](input)),
    previewDatabaseCompaction: (input) =>
      transport.request((client) => client[DATABASE_COMPACTION_WS_METHODS.preview](input)),
    startDatabaseCompaction: (input) =>
      transport.request((client) => client[DATABASE_COMPACTION_WS_METHODS.start](input)),
  };
}
