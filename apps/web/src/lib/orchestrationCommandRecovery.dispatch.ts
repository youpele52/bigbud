import type { ClientOrchestrationCommand } from "@bigbud/contracts/orchestration/orchestration.commands.ts";
import type { GetCommandOutcomeResult } from "@bigbud/contracts/orchestration/orchestration.rpc.ts";
import type { NativeApi } from "@bigbud/contracts/server/ipc.nativeApi.ts";

import {
  claimPendingCommand,
  clearPendingCommand,
  readAttempt,
  savePendingCommand,
  setAttemptStatus,
  storageFrom,
  type OrchestrationCommandRecoveryOptions,
} from "./orchestrationCommandRecovery.state";
import { commandIdKey } from "./orchestrationCommandRecovery.storage";

export class OrchestrationCommandOutcomeError extends Error {
  readonly status: "rejected" | "unknown";
  readonly reason: string | undefined;

  constructor(outcome: Extract<GetCommandOutcomeResult, { status: "rejected" | "unknown" }>) {
    super(
      outcome.status === "rejected"
        ? `Orchestration command was rejected: ${outcome.reason}.`
        : "Orchestration command outcome is not yet known.",
    );
    this.name = "OrchestrationCommandOutcomeError";
    this.status = outcome.status;
    this.reason = outcome.status === "rejected" ? outcome.reason : undefined;
  }
}

async function recoverOutcome(
  api: Pick<NativeApi, "orchestration">,
  command: ClientOrchestrationCommand,
  dispatchError: unknown,
  options?: OrchestrationCommandRecoveryOptions,
  persistUnknown = true,
): Promise<{ sequence: number }> {
  let outcome: GetCommandOutcomeResult;
  try {
    outcome = await api.orchestration.getCommandOutcome({ commandId: command.commandId });
  } catch {
    if (persistUnknown) {
      await setAttemptStatus(command.commandId, "pending", options).catch(() => undefined);
    }
    throw dispatchError;
  }
  if (outcome.status === "accepted") {
    await setAttemptStatus(
      command.commandId,
      "accepted-awaiting-event",
      options,
      outcome.resultSequence,
    ).catch(() => undefined);
    return { sequence: outcome.resultSequence };
  }
  if (outcome.status === "rejected") {
    await clearPendingCommand(command.commandId, options).catch(() => undefined);
  } else if (persistUnknown) {
    await setAttemptStatus(command.commandId, "pending", options).catch(() => undefined);
  }
  throw new OrchestrationCommandOutcomeError(outcome);
}

export async function dispatchClaimedCommand(
  api: Pick<NativeApi, "orchestration">,
  command: ClientOrchestrationCommand,
  options?: OrchestrationCommandRecoveryOptions,
): Promise<{ sequence: number }> {
  try {
    const result = await api.orchestration.dispatchCommand(command);
    await setAttemptStatus(
      command.commandId,
      "accepted-awaiting-event",
      options,
      result?.sequence ?? null,
    ).catch(() => undefined);
    return result;
  } catch (dispatchError) {
    return recoverOutcome(api, command, dispatchError, options);
  }
}

export async function dispatchCommandWithOutcomeRecovery(
  api: Pick<NativeApi, "orchestration">,
  command: ClientOrchestrationCommand,
  options?: OrchestrationCommandRecoveryOptions,
): Promise<{ sequence: number }> {
  if (!storageFrom(options)) {
    return dispatchClaimedCommand(api, command, options);
  }
  const existingAttempt = readAttempt(commandIdKey(command.commandId), options);
  await savePendingCommand(command, options);
  if (existingAttempt) {
    if (
      existingAttempt.status === "accepted-awaiting-event" &&
      existingAttempt.acceptedSequence !== null
    ) {
      return { sequence: existingAttempt.acceptedSequence };
    }
    return recoverOutcome(
      api,
      command,
      new Error("Command recovery is required before retry."),
      options,
      false,
    );
  }
  if (!(await claimPendingCommand(command.commandId, options))) {
    return recoverOutcome(
      api,
      command,
      new Error("Another client is dispatching this command."),
      options,
      false,
    );
  }
  return dispatchClaimedCommand(api, command, options);
}
