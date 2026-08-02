import {
  OrchestrationActorKind,
  OrchestrationEvent,
} from "@bigbud/contracts/orchestration/orchestration.events.ts";
import { Effect, Schema } from "effect";

import { normalizeRemovedProviderSelectionsForValidation } from "../../provider/providerSelectionCompatibility.ts";
import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type OrchestrationEventStoreError,
} from "../Errors.ts";

const decodeEvent = Schema.decodeUnknownEffect(OrchestrationEvent);

export const decodeEventCompat = (row: unknown) =>
  decodeEvent(row).pipe(
    Effect.catch(() =>
      decodeEvent(normalizeRemovedProviderSelectionsForValidation(row)).pipe(
        Effect.as(row as OrchestrationEvent),
      ),
    ),
  );

export function inferActorKind(
  event: Omit<OrchestrationEvent, "sequence">,
): Schema.Schema.Type<typeof OrchestrationActorKind> {
  if (event.commandId !== null && event.commandId.startsWith("provider:")) return "provider";
  if (event.commandId !== null && event.commandId.startsWith("server:")) return "server";
  if (
    event.metadata.providerTurnId !== undefined ||
    event.metadata.providerItemId !== undefined ||
    event.metadata.adapterKey !== undefined
  ) {
    return "provider";
  }
  return event.commandId === null ? "server" : "client";
}

export function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): OrchestrationEventStoreError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}
