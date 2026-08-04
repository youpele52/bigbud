import path from "node:path";

import type { ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  cleanupProviderLogDirectories,
  makeEventNdjsonLogger,
} from "./provider/Layers/EventNdjsonLogger.ts";

export const makeProviderLogSecurity = Effect.fn("makeProviderLogSecurity")(function* (input: {
  readonly baseDir: string;
  readonly devUrl: URL | undefined;
  readonly providerEventLogPath: string;
  readonly sql: SqlClient.SqlClient;
}) {
  yield* cleanupProviderLogDirectories([
    path.join(input.baseDir, "userdata", "logs", "provider"),
    path.join(input.baseDir, "dev", "logs", "provider"),
  ]);
  const authorizeThreadWrite = (threadId: ThreadId) =>
    input.sql<{ allowed: number }>`
      SELECT NOT (
        EXISTS (SELECT 1 FROM projection_threads WHERE thread_id = ${threadId}
          AND (deleting_at IS NOT NULL OR deleted_at IS NOT NULL))
        OR EXISTS (SELECT 1 FROM orchestration_deletion_markers
          WHERE entity_kind = 'thread' AND entity_id = ${threadId})
        OR EXISTS (SELECT 1 FROM purge_resource_claims
          WHERE entity_kind = 'thread' AND entity_id = ${threadId})
      ) AS allowed
    `.pipe(
      Effect.map((rows) => rows[0]?.allowed === 1),
      Effect.catchCause(() => Effect.succeed(false)),
    );
  const nativeEventLogger =
    input.devUrl === undefined
      ? undefined
      : yield* makeEventNdjsonLogger(input.providerEventLogPath, {
          stream: "native",
          authorizeThreadWrite,
        });
  const canonicalEventLogger =
    input.devUrl === undefined
      ? undefined
      : yield* makeEventNdjsonLogger(input.providerEventLogPath, {
          stream: "canonical",
          authorizeThreadWrite,
        });
  const settleThreadLogs = (threadId: ThreadId) =>
    Effect.all(
      [
        nativeEventLogger?.closeThread(threadId),
        canonicalEventLogger?.closeThread(threadId),
      ].filter((effect): effect is Effect.Effect<void> => effect !== undefined),
      { discard: true },
    );
  return { canonicalEventLogger, nativeEventLogger, settleThreadLogs };
});
