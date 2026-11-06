import { Schema } from "effect";
import { ClientOrchestrationCommand } from "@bigbud/contracts/orchestration/orchestration.commands.ts";
import type { ProjectId } from "@bigbud/contracts";
import { resolveLedgerStorage } from "../../stores/ledger/revisionedLedger";
import {
  dispatchClaimedCommand,
  OrchestrationCommandOutcomeError,
} from "../../lib/orchestrationCommandRecovery";
import {
  claimPendingCommand,
  savePendingCommand,
} from "../../lib/orchestrationCommandRecovery.state";
import { ensureNativeApi } from "../../rpc/nativeApi";

export interface ProjectEditRecovery {
  readonly command: ClientOrchestrationCommand;
  readonly error: string | null;
}
const key = (projectId: ProjectId) => `bigbud:project-edit-recovery:v1:${projectId}`;

export function readProjectEditRecovery(projectId: ProjectId): ProjectEditRecovery | null {
  const raw = resolveLedgerStorage()?.getItem(key(projectId));
  if (!raw) return null;
  // Corruption is not evidence that a potentially dispatched operation can be forgotten.
  const value = JSON.parse(raw) as ProjectEditRecovery;
  const command = Schema.decodeUnknownSync(ClientOrchestrationCommand)(value.command);
  if (
    (command.type !== "project.reconfigure" && command.type !== "project.meta.update") ||
    command.projectId !== projectId
  ) {
    throw new Error(
      "Saved project edit identity is invalid. Recovery must be inspected before editing.",
    );
  }
  // Validate without replacing the original request with decoder defaults/normalization.
  // Its exact JSON and ID are the server's retained native-operation identity.
  return { command: value.command, error: typeof value.error === "string" ? value.error : null };
}

export function retainProjectEdit(projectId: ProjectId, recovery: ProjectEditRecovery) {
  const storage = resolveLedgerStorage();
  if (!storage)
    throw new Error("Durable recovery storage is unavailable. No project edit was sent.");
  storage.setItem(key(projectId), JSON.stringify(recovery));
  if (storage.getItem(key(projectId)) !== JSON.stringify(recovery)) {
    throw new Error("The project edit could not be retained safely. No project edit was sent.");
  }
}

export function clearProjectEdit(projectId: ProjectId) {
  resolveLedgerStorage()?.removeItem?.(key(projectId));
}

/** Explicit retry only: observe receipt first, then send the immutable retained command.
 * Server receipt/native-operation identity owns idempotency; never reconstruct revisions or consent.
 */
export async function retryProjectEdit(projectId: ProjectId) {
  const retained = readProjectEditRecovery(projectId);
  if (!retained) throw new Error("No retained project edit was found.");
  const api = ensureNativeApi();
  const outcome = await api.orchestration.getCommandOutcome({
    commandId: retained.command.commandId,
  });
  if (outcome.status === "accepted") {
    clearProjectEdit(projectId);
    return;
  }
  if (outcome.status === "rejected") {
    clearProjectEdit(projectId);
    throw new OrchestrationCommandOutcomeError(outcome);
  }
  await savePendingCommand(retained.command);
  if (!(await claimPendingCommand(retained.command.commandId))) {
    throw new Error("This edit is still being dispatched. Wait before checking again.");
  }
  try {
    await dispatchClaimedCommand(api, retained.command);
    clearProjectEdit(projectId);
  } catch (cause) {
    if (cause instanceof OrchestrationCommandOutcomeError && cause.status === "rejected")
      clearProjectEdit(projectId);
    else
      retainProjectEdit(projectId, {
        ...retained,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    throw cause;
  }
}
