import { CommandId, type ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import { lockThreadTitle } from "./ThreadTitleLock.ts";

export const agentThreadCommandId = (tag: string): CommandId =>
  CommandId.makeUnsafe(`agent:${tag}:${crypto.randomUUID()}`);

export const renameThreadViaOrchestration = Effect.fn("renameThreadViaOrchestration")(
  function* (input: {
    readonly orchestrationEngine: OrchestrationEngineShape;
    readonly threadId: ThreadId;
    readonly title: string;
  }) {
    const trimmed = input.title.trim();
    if (trimmed.length === 0) {
      return yield* Effect.fail(new Error("Thread title cannot be empty."));
    }

    yield* input.orchestrationEngine.dispatch({
      type: "thread.meta.update",
      commandId: agentThreadCommandId("thread-rename"),
      threadId: input.threadId,
      title: trimmed,
    });
    lockThreadTitle(input.threadId);
    return { title: trimmed } as const;
  },
);

export const archiveThreadViaOrchestration = Effect.fn("archiveThreadViaOrchestration")(
  function* (input: {
    readonly orchestrationEngine: OrchestrationEngineShape;
    readonly threadId: ThreadId;
  }) {
    yield* input.orchestrationEngine.dispatch({
      type: "thread.archive",
      commandId: agentThreadCommandId("thread-archive"),
      threadId: input.threadId,
    });
    return { archived: true } as const;
  },
);
