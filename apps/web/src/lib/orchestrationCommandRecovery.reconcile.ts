import type { ClientOrchestrationCommand } from "@bigbud/contracts/orchestration/orchestration.commands.ts";
import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";
import type { NativeApi } from "@bigbud/contracts/server/ipc.nativeApi.ts";

import { subscribeToLedgerChanges } from "../stores/ledger/revisionedLedger";
import {
  commandIdKey,
  ORCHESTRATION_COMMAND_LEDGER_CHANNEL,
  ORCHESTRATION_COMMAND_LEDGER_KEY,
  type PersistedCommandAttempt,
} from "./orchestrationCommandRecovery.storage";
import {
  clearPendingCommand,
  mutateLedger,
  readAttempt,
  readPendingCommands,
  setAttemptStatus,
  storageFrom,
  type OrchestrationCommandRecoveryOptions,
} from "./orchestrationCommandRecovery.state";
export interface PersistedCommandRecoverySummary {
  readonly accepted: number;
  readonly rejected: number;
  readonly retried: number;
  readonly pending: number;
}

export async function reconcilePersistedCommands(
  api: Pick<NativeApi, "orchestration">,
  options?: OrchestrationCommandRecoveryOptions,
): Promise<PersistedCommandRecoverySummary> {
  const summary = { accepted: 0, rejected: 0, retried: 0, pending: 0 };
  for (const entry of readPendingCommands(options)) {
    const commandId = commandIdKey(entry.commandId);
    try {
      const outcome = await api.orchestration.getCommandOutcome({
        commandId: entry.commandId,
      });
      if (outcome.status === "accepted") {
        await setAttemptStatus(
          entry.commandId,
          "accepted-awaiting-event",
          options,
          outcome.resultSequence,
        );
        summary.accepted += 1;
        continue;
      }
      if (outcome.status === "rejected") {
        await clearPendingCommand(entry.commandId, options);
        summary.rejected += 1;
        continue;
      }
    } catch {
      await setAttemptStatus(entry.commandId, "pending", options).catch(() => undefined);
      summary.pending += 1;
      continue;
    }
    await setAttemptStatus(commandId, "pending", options).catch(() => undefined);
    summary.pending += 1;
  }
  return summary;
}

export async function clearPersistedCommandsForCanonicalEvents(
  events: ReadonlyArray<OrchestrationEvent>,
  options?: OrchestrationCommandRecoveryOptions,
): Promise<number> {
  const commandIds = new Set(
    events.flatMap((event) => (event.commandId === null ? [] : [commandIdKey(event.commandId)])),
  );
  if (commandIds.size === 0 || !storageFrom(options)) return 0;
  return mutateLedger(options, (ledger, mutationId) => {
    const attemptsByCommandId = Object.fromEntries(
      Object.entries(ledger.attemptsByCommandId).filter(
        ([commandId]) => !commandIds.has(commandId),
      ),
    );
    const cleared =
      Object.keys(ledger.attemptsByCommandId).length - Object.keys(attemptsByCommandId).length;
    if (cleared === 0) return { ledger, result: 0 };
    return {
      ledger: {
        ...ledger,
        revision: ledger.revision + 1,
        lastMutationId: mutationId,
        attemptsByCommandId,
      },
      result: cleared,
    };
  });
}

export function subscribeToPersistedCommandChanges(
  listener: (revision: number) => void,
): () => void {
  return subscribeToLedgerChanges({
    key: ORCHESTRATION_COMMAND_LEDGER_KEY,
    channelName: ORCHESTRATION_COMMAND_LEDGER_CHANNEL,
    listener,
  });
}

export function getPersistedCommandAttempt(
  commandId: ClientOrchestrationCommand["commandId"],
  options?: OrchestrationCommandRecoveryOptions,
): PersistedCommandAttempt | undefined {
  return readAttempt(commandIdKey(commandId), options);
}
