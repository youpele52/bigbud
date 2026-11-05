import { Schema } from "effect";
import { ProviderRuntimeEvent } from "@bigbud/contracts/orchestration/providerRuntime.events.ts";

export const INSPECTION_TERMINAL_KEY = "bigbud.codex.inspectionTerminal";
export const InspectionTerminal = Schema.Struct({
  version: Schema.Literal(1),
  nativeThreadId: Schema.String,
  terminal: ProviderRuntimeEvent,
  items: Schema.Array(ProviderRuntimeEvent),
  acknowledgements: Schema.Struct({
    ingestion: Schema.Boolean,
    checkpoint: Schema.Boolean,
    recovery: Schema.Boolean,
  }),
});
export type InspectionTerminal = typeof InspectionTerminal.Type;
export type InspectionTerminalConsumer = keyof InspectionTerminal["acknowledgements"];
export type InspectionConfirmation = "confirmed" | "absent" | "rejected";

/** Unknown journal formats remain fenced rather than silently losing a terminal outcome. */
export function hasPendingInspectionTerminal(payload: unknown): boolean {
  if (
    !payload ||
    typeof payload !== "object" ||
    !(INSPECTION_TERMINAL_KEY in payload) ||
    payload[INSPECTION_TERMINAL_KEY] == null
  )
    return false;
  const record = payload[INSPECTION_TERMINAL_KEY];
  if (
    !record ||
    typeof record !== "object" ||
    !("version" in record) ||
    record.version !== 1 ||
    !("acknowledgements" in record)
  )
    return true;
  const acks = record.acknowledgements;
  return (
    !acks ||
    typeof acks !== "object" ||
    !("ingestion" in acks) ||
    acks.ingestion !== true ||
    !("checkpoint" in acks) ||
    acks.checkpoint !== true ||
    !("recovery" in acks) ||
    acks.recovery !== true
  );
}

export function isInspectedTerminal(event: ProviderRuntimeEvent): boolean {
  return (
    event.provider === "codex" &&
    event.type === "turn.completed" &&
    event.payload.recoveryRedelivery === true &&
    event.raw?.method === "bigbud.inspectedTerminal"
  );
}
