import { Effect, Option, Schema } from "effect";
import type { ProviderRuntimeEvent } from "@bigbud/contracts/orchestration/providerRuntime.events.ts";
import type { ProviderSessionDirectoryShape } from "../Services/ProviderSessionDirectory.ts";
import type { ProviderServiceShape } from "../Services/ProviderService.ts";
import {
  INSPECTION_TERMINAL_KEY,
  InspectionTerminal,
  isInspectedTerminal,
} from "../Services/ProviderInspectionTerminal.ts";
import { readPersistedSessionEpoch, toValidationError } from "./ProviderServiceHelpers.ts";
import { readResumeThreadId } from "../../codex/codexAppServerManager.utils.ts";

/** Journal first, then ordinary terminal publication; replay never invokes native model work. */
export function makeInspectionDelivery(
  directory: ProviderSessionDirectoryShape,
  publish: (event: ProviderRuntimeEvent) => Effect.Effect<void>,
): Pick<
  ProviderServiceShape,
  | "recordInspectionTerminal"
  | "listInspectionTerminals"
  | "publishInspectionTerminal"
  | "acknowledgeInspectionTerminal"
  | "inspectionTerminalReady"
> {
  let after: string | undefined;
  return {
    inspectionTerminalReady: (event) =>
      Effect.gen(function* () {
        if (!isInspectedTerminal(event)) return true;
        const binding = Option.getOrUndefined(yield* directory.getBinding(event.threadId));
        const payload = binding?.runtimePayload;
        const record =
          payload && typeof payload === "object" && INSPECTION_TERMINAL_KEY in payload
            ? payload[INSPECTION_TERMINAL_KEY]
            : undefined;
        return (
          Schema.is(InspectionTerminal)(record) &&
          record.terminal.eventId === event.eventId &&
          record.acknowledgements.checkpoint
        );
      }),
    recordInspectionTerminal: (terminal, items) =>
      Effect.gen(function* () {
        const binding = Option.getOrUndefined(yield* directory.getBinding(terminal.threadId));
        const nativeThreadId = binding && readResumeThreadId(binding);
        if (
          !directory.storeInspectionTerminal ||
          !isInspectedTerminal(terminal) ||
          !binding ||
          binding.provider !== "codex" ||
          !nativeThreadId ||
          readPersistedSessionEpoch(binding.runtimePayload) !== terminal.sessionEpoch ||
          !terminal.turnId ||
          items.some(
            (item) =>
              item.threadId !== terminal.threadId ||
              item.turnId !== terminal.turnId ||
              item.sessionEpoch !== terminal.sessionEpoch,
          )
        )
          return yield* toValidationError(
            "ProviderService.inspectionTerminal",
            "Exact durable terminal publication identity is unavailable.",
          );
        yield* directory.storeInspectionTerminal({
          version: 1,
          nativeThreadId,
          terminal,
          items,
          acknowledgements: { ingestion: false, checkpoint: false, recovery: false },
        });
      }),
    listInspectionTerminals: () =>
      Effect.gen(function* () {
        const rows = yield* directory.listInspectionTerminals?.(after) ?? Effect.succeed([]);
        after = rows.length === 100 ? rows.at(-1)?.terminal.threadId : undefined;
        return rows;
      }),
    publishInspectionTerminal: (record) =>
      Effect.gen(function* () {
        const binding = Option.getOrUndefined(
          yield* directory.getBinding(record.terminal.threadId),
        );
        if (
          !binding ||
          binding.provider !== "codex" ||
          readPersistedSessionEpoch(binding.runtimePayload) !== record.terminal.sessionEpoch ||
          readResumeThreadId(binding) !== record.nativeThreadId
        )
          return;
        yield* publish(record.terminal);
      }),
    acknowledgeInspectionTerminal: (event, consumer) =>
      !isInspectedTerminal(event)
        ? Effect.void
        : (directory.acknowledgeInspectionTerminal?.(event.threadId, event.eventId, consumer) ??
          Effect.fail(
            toValidationError(
              "ProviderService.inspectionTerminal",
              "Durable terminal acknowledgement is unavailable.",
            ),
          )),
  };
}
