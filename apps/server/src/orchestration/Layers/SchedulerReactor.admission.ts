import type { AutomationRun, OrchestrationThread } from "@bigbud/contracts";

/** Durable user-message presence proves application admission, not native execution/completion. */
export function automationAlreadyAdmitted(
  thread: OrchestrationThread | undefined,
  run: AutomationRun,
) {
  return (
    thread?.messages.some((message) => message.role === "user" && message.id === run.messageId) ===
    true
  );
}

/** Scheduled work may use explicit Full access host-user trust, never infer that trust from an unattended launch. */
export function automationProviderLimitation(thread: OrchestrationThread | undefined) {
  return thread?.modelSelection.provider === "opencodeV2" && thread.runtimeMode !== "full-access"
    ? "OpenCode v2 (Preview) scheduled actions require supervision in approval-required/Auto edits modes. Explicitly user-selected Full access permits ordinary native workspace tools; external-directory requests/forms may still require an operator. No automatic trust escalation or provider fallback."
    : undefined;
}
