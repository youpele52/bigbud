import type {
  ModelSelection,
  OrchestrationThread,
  ProviderKind,
  ThreadId,
} from "@bigbud/contracts";
import { Effect } from "effect";

import { resolveProviderSessionExecutionTargets } from "../../provider/providerSessionExecutionTargets.ts";
import type { SessionOpServices } from "./ProviderCommandReactorSessionOps.types.ts";

export function startProviderSession(input: {
  readonly services: Pick<SessionOpServices, "providerService" | "setThreadSession">;
  readonly thread: OrchestrationThread;
  readonly threadId: ThreadId;
  readonly createdAt: string;
  readonly provider: ProviderKind;
  readonly modelSelection: ModelSelection;
  readonly cwd: string | undefined;
  readonly fresh?: boolean;
  readonly resumeCursor?: unknown;
  readonly preserveExistingBinding?: boolean;
}) {
  const executionTargets = resolveProviderSessionExecutionTargets({
    providerRuntimeExecutionTargetId: input.thread.providerRuntimeExecutionTargetId,
    workspaceExecutionTargetId: input.thread.workspaceExecutionTargetId,
    executionTargetId: input.thread.executionTargetId,
  });
  const markSessionStarting = input.services.setThreadSession({
    threadId: input.threadId,
    session: {
      threadId: input.threadId,
      status: "starting",
      providerName: input.provider,
      runtimeMode: input.thread.runtimeMode,
      activeTurnId: null,
      lastError: null,
      updatedAt: input.createdAt,
    },
    createdAt: input.createdAt,
  });
  const startSession = (
    input.fresh
      ? input.services.providerService.startSessionFresh
      : input.services.providerService.startSession
  )(input.threadId, {
    threadId: input.threadId,
    provider: input.provider,
    ...executionTargets,
    ...(input.cwd ? { cwd: input.cwd } : {}),
    modelSelection: input.modelSelection,
    ...(input.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
    runtimeMode: input.thread.runtimeMode,
  });

  return input.preserveExistingBinding
    ? startSession
    : markSessionStarting.pipe(Effect.andThen(startSession));
}
