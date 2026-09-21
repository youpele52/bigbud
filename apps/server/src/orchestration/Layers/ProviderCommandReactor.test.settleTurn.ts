import { CommandId, ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";

import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";

const liveSessionSettlers = new WeakMap<OrchestrationEngineShape, (threadId: ThreadId) => void>();

export function registerLiveSessionSettler(
  engine: OrchestrationEngineShape,
  settleLiveSession: (threadId: ThreadId) => void,
): void {
  liveSessionSettlers.set(engine, settleLiveSession);
}

export async function settleActiveTurn(
  engine: OrchestrationEngineShape,
  commandId: string,
  createdAt: string,
  options: {
    readonly providerName?: "claudeAgent" | "codex" | "cursor";
    readonly runtimeMode?: "approval-required" | "full-access";
  } = {},
): Promise<void> {
  const threadId = ThreadId.makeUnsafe("thread-1");
  liveSessionSettlers.get(engine)?.(threadId);
  await Effect.runPromise(
    engine.dispatch({
      type: "thread.session.set",
      commandId: CommandId.makeUnsafe(commandId),
      threadId,
      session: {
        threadId,
        status: "ready",
        providerName: options.providerName ?? "codex",
        runtimeMode: options.runtimeMode ?? "approval-required",
        activeTurnId: null,
        lastError: null,
        updatedAt: createdAt,
      },
      createdAt,
    }),
  );
}
