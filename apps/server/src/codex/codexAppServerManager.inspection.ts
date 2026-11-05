import type { TurnId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { ProviderActiveTurnInspection } from "@bigbud/contracts/orchestration/provider.ts";
import { hasQualifiedCodexModernProtocol } from "./codexAppServerManager.capabilities.ts";
import {
  readCodexThreadHistory,
  verifyCodexHistoryStable,
} from "./codexAppServerManager.history.ts";
import type {
  CodexSessionContext,
  CodexThreadTurnSnapshot,
} from "./codexAppServerManager.types.ts";
import type { TurnOps } from "./codexAppServerManager.turn.ts";
import { readResumeThreadId } from "./codexAppServerManager.utils.ts";
import { guardProviderPublication } from "../provider/providerPublication.ts";
import type { InspectionConfirmation } from "../provider/Services/ProviderInspectionTerminal.ts";
import type { ProviderRuntimeEvent } from "@bigbud/contracts/orchestration/providerRuntime.events.ts";

export type CodexTurnInspection = ProviderActiveTurnInspection & {
  readonly turn?: CodexThreadTurnSnapshot;
};

const unavailable = (): CodexTurnInspection => ({
  status: "unavailable",
  observedAt: new Date().toISOString(),
});

/** A stale process or native event cannot acknowledge a newer canonical turn. */
export function confirmCodexInspectedTurn(
  context: CodexSessionContext | undefined,
  turnId: TurnId,
  epoch: number,
  status: "completed" | "failed",
  ops: Pick<TurnOps, "updateSession">,
  publication?: ProviderRuntimeEvent,
  isCurrent?: () => boolean,
): InspectionConfirmation {
  const check = (): InspectionConfirmation => {
    if (isCurrent?.() === false) return "rejected";
    if (!context || context.child.exitCode !== null || context.child.signalCode != null)
      return "absent";
    const evidence = context.inspectedTerminal;
    return !context.stopping &&
      !context.child.killed &&
      context.session.sessionEpoch === epoch &&
      evidence?.epoch === epoch &&
      evidence.turnId === turnId &&
      evidence.status === status &&
      evidence.generation === (context.historyGeneration ?? 0) &&
      (context.session.activeTurnId === undefined || context.session.activeTurnId === turnId)
      ? "confirmed"
      : "rejected";
  };
  const result = check();
  if (result === "confirmed")
    ops.updateSession(context!, {
      activeTurnId: undefined,
      status: status === "failed" ? "error" : "ready",
    });
  if (publication && result !== "rejected")
    guardProviderPublication(publication, () => {
      if (check() !== result)
        throw new Error("Inspected Codex terminal lost native publication authority.");
    });
  return result;
}

/** Interrupted history is normalized by Codex on idle reads and cannot establish an outcome. */
export async function inspectCodexTurn(
  context: CodexSessionContext,
  turnId: TurnId,
  ops: TurnOps,
): Promise<CodexTurnInspection> {
  const nativeId = readResumeThreadId(context.session);
  const epoch = context.session.sessionEpoch;
  const alive = () =>
    !context.stopping &&
    !context.child.killed &&
    context.child.exitCode === null &&
    context.session.status !== "closed" &&
    epoch === context.session.sessionEpoch &&
    nativeId === readResumeThreadId(context.session);
  if (
    !alive() ||
    !nativeId ||
    context.ownedTurnId !== turnId ||
    !hasQualifiedCodexModernProtocol(context.runtimeVersion)
  )
    return unavailable();
  try {
    const history = await readCodexThreadHistory(context, ops);
    await verifyCodexHistoryStable(context, history, ops);
    if (
      !alive() ||
      history.threadId !== nativeId ||
      history.ephemeral !== false ||
      history.historyMode !== "paginated"
    )
      return unavailable();
    const turn = history.turns.find((entry) => entry.id === turnId);
    const observedAt = new Date().toISOString();
    if (!turn)
      return history.nativeStatus === "idle" && !context.session.activeTurnId
        ? { status: "missing", observedAt }
        : unavailable();
    if (turn.status === "inProgress") {
      if (context.session.activeTurnId !== turnId || history.nativeStatus !== "active")
        return unavailable();
      const requests = [
        ...context.pendingApprovals.values(),
        ...context.pendingUserInputs.values(),
      ];
      if (
        requests.some(
          (request) =>
            request.nativeThreadId === nativeId && request.epoch === epoch && !request.nativeTurnId,
        )
      )
        return unavailable();
      const waiting = requests.some(
        (request) =>
          request.nativeThreadId === nativeId &&
          request.nativeTurnId === turnId &&
          request.epoch === epoch,
      );
      return { status: waiting ? "waiting-for-user" : "running", observedAt };
    }
    if (
      context.retryingTurnId === turnId ||
      history.nativeStatus !== "idle" ||
      (context.session.activeTurnId && context.session.activeTurnId !== turnId) ||
      [...context.pendingApprovals.values(), ...context.pendingUserInputs.values()].some(
        (request) =>
          request.nativeThreadId === nativeId &&
          request.nativeTurnId === turnId &&
          request.epoch === epoch,
      )
    )
      return unavailable();
    if ((turn.status === "completed" || turn.status === "failed") && turn.completedAt) {
      context.inspectedTerminal = {
        turnId,
        epoch,
        status: turn.status,
        generation: context.historyGeneration ?? 0,
      };
    } else return unavailable();
    if (turn.status === "completed")
      return {
        status: "completed",
        observedAt,
        turn,
        completionEvidence: {
          source: "codex.complete-native-history",
          detail: `Exact native turn ${turnId} durably completed.`,
        },
      };
    if (turn.status === "failed")
      return {
        status: "failed",
        observedAt,
        turn,
        errorEvidence: {
          source: "codex.complete-native-history",
          detail: `Exact native turn ${turnId} durably failed.`,
        },
      };
    return unavailable();
  } catch {
    return unavailable();
  }
}
