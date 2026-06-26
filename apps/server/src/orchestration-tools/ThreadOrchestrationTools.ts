import { CommandId, type ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import { resolveThreadWorkflowStatus } from "../orchestration/ThreadWorkflowStatus.logic.ts";
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

export const getThreadStatusViaOrchestration = Effect.fn("getThreadStatusViaOrchestration")(
  function* (input: {
    readonly orchestrationEngine: OrchestrationEngineShape;
    readonly callerThreadId: ThreadId;
    readonly threadId: ThreadId;
  }) {
    const readModel = yield* input.orchestrationEngine.getReadModel();
    const callerThread = readModel.threads.find((thread) => thread.id === input.callerThreadId);
    if (!callerThread) {
      return yield* Effect.fail(new Error("Caller thread could not be resolved."));
    }

    const targetThread = readModel.threads.find((thread) => thread.id === input.threadId);
    if (!targetThread) {
      return yield* Effect.fail(new Error(`Thread '${input.threadId}' was not found.`));
    }
    if (targetThread.projectId !== callerThread.projectId) {
      return yield* Effect.fail(
        new Error(`Thread '${input.threadId}' is not accessible from the current project.`),
      );
    }

    return resolveThreadWorkflowStatus(targetThread);
  },
);
