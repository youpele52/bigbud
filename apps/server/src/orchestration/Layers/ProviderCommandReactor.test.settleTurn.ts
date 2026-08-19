import { CommandId, ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";

import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";

export async function settleActiveTurn(
  engine: OrchestrationEngineShape,
  commandId: string,
  createdAt: string,
  options: {
    readonly providerName?: "claudeAgent" | "codex";
    readonly runtimeMode?: "approval-required" | "full-access";
  } = {},
): Promise<void> {
  const threadId = ThreadId.makeUnsafe("thread-1");
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
