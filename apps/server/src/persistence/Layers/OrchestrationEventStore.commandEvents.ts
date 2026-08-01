import { CommandId } from "@bigbud/contracts";
import { Effect, Schema } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceDecodeError } from "../Errors.ts";
import type { OrchestrationEventStoreShape } from "../Services/OrchestrationEventStore.ts";
import {
  decodeEventCompat,
  toPersistenceSqlOrDecodeError,
} from "./OrchestrationEventStore.utils.ts";
import { OrchestrationEventPersistedRowSchema } from "./OrchestrationEventStore.schemas.ts";

const MAX_EVENTS_PER_COMMAND = 100;
const ReadByCommandIdRequestSchema = Schema.Struct({ commandId: CommandId });

export function makeReadByCommandId(
  sql: SqlClient.SqlClient,
): NonNullable<OrchestrationEventStoreShape["readByCommandId"]> {
  const readRows = SqlSchema.findAll({
    Request: ReadByCommandIdRequestSchema,
    Result: OrchestrationEventPersistedRowSchema,
    execute: (request) =>
      sql`
        SELECT
          sequence,
          event_id AS "eventId",
          event_type AS "type",
          aggregate_kind AS "aggregateKind",
          stream_id AS "aggregateId",
          occurred_at AS "occurredAt",
          command_id AS "commandId",
          causation_event_id AS "causationEventId",
          correlation_id AS "correlationId",
          payload_json AS "payload",
          metadata_json AS "metadata"
        FROM orchestration_events
        WHERE command_id = ${request.commandId}
        ORDER BY sequence ASC
        LIMIT ${MAX_EVENTS_PER_COMMAND}
      `,
  });
  return (commandId) =>
    readRows({ commandId }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "OrchestrationEventStore.readByCommandId:query",
          "OrchestrationEventStore.readByCommandId:decodeRows",
        ),
      ),
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          decodeEventCompat(row).pipe(
            Effect.mapError(
              toPersistenceDecodeError("OrchestrationEventStore.readByCommandId:rowToEvent"),
            ),
          ),
        ),
      ),
    );
}
