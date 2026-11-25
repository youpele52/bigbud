import { refusePendingInteractions } from "../provider/pendingInteractionAdmission.ts";
import type { CodexSessionContext } from "./codexAppServerManager.types.ts";

const pendingFences = new WeakSet<object>();

export function assertCodexInteractionAdmission(context: CodexSessionContext) {
  const refusal = refusePendingInteractions({
    provider: "codex",
    sessionEpoch: context.session.sessionEpoch ?? 0,
    approvals: context.pendingApprovals,
    userInputs: context.pendingUserInputs,
  });
  if (!refusal) return;
  for (const pending of context.pendingApprovals.values()) pendingFences.add(pending);
  for (const pending of context.pendingUserInputs.values()) pendingFences.add(pending);
  throw refusal;
}

export function hasCodexPendingInteractionFence(pending: object) {
  return pendingFences.has(pending);
}
