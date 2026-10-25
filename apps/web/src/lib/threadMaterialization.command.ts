import { CommandId, type ThreadId } from "@bigbud/contracts/core/baseSchemas";
import type { NativeApi } from "@bigbud/contracts/server/ipc.nativeApi.ts";

/** Share a stable creation command across windows; only an explicitly rejected attempt gets a new ID. */
export async function resolveOwnerCreationCommand(api: NativeApi, threadId: ThreadId) {
  let commandId = CommandId.makeUnsafe(`thread-owner:${threadId}`);
  for (let attempt = 0; attempt < 16; attempt++) {
    const outcome = await api.orchestration.getCommandOutcome({ commandId });
    if (
      outcome.status !== "unknown" &&
      (outcome.aggregateKind !== "thread" || outcome.aggregateId !== threadId)
    ) {
      throw new Error(
        "Saved chat creation has a mismatched outcome. Reconnect to reconcile ownership.",
      );
    }
    if (outcome.status !== "rejected") return { commandId, outcome };
    commandId = CommandId.makeUnsafe(`thread-owner:${threadId}:after:${outcome.resultSequence}`);
  }
  throw new Error(
    "This chat has too many rejected save attempts. Start a new chat; your draft is retained.",
  );
}
