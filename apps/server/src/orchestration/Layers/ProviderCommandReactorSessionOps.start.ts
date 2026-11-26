import type {
  ModelSelection,
  OrchestrationThread,
  ProviderKind,
  RuntimeMode,
  ThreadId,
} from "@bigbud/contracts";
import { Effect } from "effect";

import { resolveProviderSessionExecutionTargets } from "../../provider/providerSessionExecutionTargets.ts";
import { assertSessionSshTargetsReady } from "./ProviderCommandReactorSessionOps.preflight.ts";
import type { SessionOpServices } from "./ProviderCommandReactorSessionOps.types.ts";

export function startProviderSession(input: {
  readonly services: Pick<
    SessionOpServices,
    "providerService" | "setThreadSession" | "assertRuntimeStartAllowed"
  >;
  readonly thread: OrchestrationThread;
  readonly threadId: ThreadId;
  readonly createdAt: string;
  readonly provider: ProviderKind;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly cwd: string | undefined;
  readonly fresh?: boolean;
  readonly resumeCursor?: unknown;
  readonly preserveExistingBinding?: boolean;
}) {
  const currentSessionEpoch = input.thread.session?.sessionEpoch ?? 0;
  const nextSessionEpoch = currentSessionEpoch + 1;
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
      runtimeMode: input.runtimeMode,
      activeTurnId: null,
      sessionEpoch: nextSessionEpoch,
      lastError: null,
      updatedAt: input.createdAt,
    },
    createdAt: input.createdAt,
    expectedSessionEpoch: currentSessionEpoch,
    advanceSessionEpoch: true,
  });
  const startSession = Effect.suspend(() =>
    (input.fresh
      ? input.services.providerService.startSessionFresh
      : input.services.providerService.startSession)(input.threadId, {
      threadId: input.threadId,
      provider: input.provider,
      ...executionTargets,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      modelSelection: input.modelSelection,
      ...(input.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
      runtimeMode: input.runtimeMode,
      sessionEpoch: nextSessionEpoch,
    }),
  );

  // A dead SSH target fails before the session is marked starting: nothing was started.
  const preflight = assertSessionSshTargetsReady({
    provider: input.provider,
    threadId: input.threadId,
    targets: executionTargets,
  });

  return preflight.pipe(
    Effect.andThen(markSessionStarting),
    Effect.andThen(input.services.assertRuntimeStartAllowed(input.threadId)),
    Effect.andThen(startSession),
  );
}
