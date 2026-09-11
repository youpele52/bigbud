import type {
  ModelSelection,
  OrchestrationThread,
  ProviderInteractionMode,
  ProviderSession,
  RuntimeMode,
} from "@bigbud/contracts";

import { ProviderValidationError } from "../../provider/Errors.ts";
import { resolveThreadWorkflowStatus } from "../ThreadWorkflowStatus.logic.ts";

export interface TurnExecutionSettings {
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

export interface ResolvedTurnExecutionSettings extends TurnExecutionSettings {
  readonly modelSelectionWasCaptured: boolean;
}

export interface EnsureSessionOptions {
  readonly modelSelection?: ModelSelection;
  readonly runtimeMode?: RuntimeMode;
  readonly restartFreshIfInactive?: boolean;
  readonly requireExactModel?: boolean;
}

// Resolve once per send, outside the retry loop. Later reads of the thread remain
// necessary for lifecycle fences, but must not change this turn's settings.
export function resolveTurnExecutionSettings(
  thread: OrchestrationThread,
  captured: Partial<TurnExecutionSettings>,
): ResolvedTurnExecutionSettings {
  return {
    modelSelectionWasCaptured: captured.modelSelection !== undefined,
    modelSelection: captured.modelSelection ?? thread.modelSelection,
    runtimeMode: captured.runtimeMode ?? thread.runtimeMode,
    interactionMode: captured.interactionMode ?? thread.interactionMode,
  };
}

export function capturedModelSelectionError(input: {
  readonly modelSelection: ModelSelection;
  readonly activeSession: ProviderSession | undefined;
  readonly sessionModelSwitch: import("../../provider/Services/ProviderAdapter.ts").ProviderSessionModelSwitchMode;
  readonly requireExactModel: boolean;
}): ProviderValidationError | undefined {
  if (
    !input.requireExactModel ||
    input.sessionModelSwitch !== "unsupported" ||
    !input.activeSession ||
    input.activeSession.model === input.modelSelection.model
  )
    return undefined;
  return new ProviderValidationError({
    operation: "ProviderCommandReactor.ensureSessionForThread",
    issue: `Provider '${input.activeSession.provider}' cannot honor captured model '${input.modelSelection.model}': the live session model is '${input.activeSession.model ?? "unknown"}' and model switching is unsupported.`,
  });
}

export function ongoingProviderWorkError(
  thread: OrchestrationThread,
  activeSession: ProviderSession | undefined,
): ProviderValidationError | undefined {
  const workflow = resolveThreadWorkflowStatus(thread);
  if (
    activeSession?.activeTurnId != null ||
    activeSession?.status === "running" ||
    activeSession?.status === "connecting" ||
    thread.session?.activeTurnId != null ||
    thread.session?.status === "running" ||
    workflow.hasPendingApprovals ||
    workflow.hasPendingUserInput
  ) {
    return new ProviderValidationError({
      operation: "ProviderCommandReactor.ensureSessionForThread",
      issue: `Thread '${thread.id}' has ongoing provider work; cannot start or reconfigure it for another prompt.`,
    });
  }
  // The turn-start projection is already "starting" for this accepted request.
  return undefined;
}
