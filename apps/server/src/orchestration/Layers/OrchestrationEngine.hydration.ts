import type {
  OrchestrationEvent,
  OrchestrationProject,
  OrchestrationReadModel,
  OrchestrationThread,
  ThreadId,
} from "@bigbud/contracts";
import { Effect, Option } from "effect";

import type { OrchestrationEventStoreShape } from "../../persistence/Services/OrchestrationEventStore.ts";
import type { ProjectionOperationalStateQueryShape } from "../Services/ProjectionOperationalStateQuery.ts";
import { projectEvent } from "../projector.ts";

export type ThreadStateLevel = "operational" | "history";

export function makeThreadStateHydrator(input: {
  readonly query: ProjectionOperationalStateQueryShape;
  readonly eventStore: OrchestrationEventStoreShape;
  readonly readModel: () => OrchestrationReadModel;
  readonly install: (input: {
    threadId: ThreadId;
    thread: OrchestrationThread | undefined;
    project: OrchestrationProject | undefined;
  }) => void;
}) {
  const historyLoaded = new Set<ThreadId>();

  const load = Effect.fn("OrchestrationEngine.ensureThreadState")(function* (
    threadId: ThreadId,
    level: ThreadStateLevel,
  ) {
    const current = input.readModel().threads.find((thread) => thread.id === threadId);
    if (level === "operational" && current) {
      return current;
    }
    if (level === "history" && current && historyLoaded.has(threadId)) {
      return current;
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const queried = yield* level === "history"
        ? input.query.getFullThreadHistory(threadId)
        : input.query.getThreadOperationalState(threadId);
      if (Option.isNone(queried)) {
        input.install({ threadId, thread: undefined, project: undefined });
        historyLoaded.delete(threadId);
        return undefined;
      }

      let hydrated = queried.value;
      let replayFrom = hydrated.snapshotSequence;
      let restart = false;
      for (;;) {
        const replay = yield* input.eventStore.readReplay(replayFrom);
        if (replay.availability === "gap") {
          restart = true;
          break;
        }
        for (const event of replay.events as ReadonlyArray<OrchestrationEvent>) {
          hydrated = yield* projectEvent(hydrated, event);
        }
        if (replay.complete) {
          break;
        }
        const nextSequence = replay.events.at(-1)?.sequence;
        if (nextSequence === undefined || nextSequence <= replayFrom) {
          restart = true;
          break;
        }
        replayFrom = nextSequence;
      }
      if (restart) {
        continue;
      }

      const thread = hydrated.threads.find((entry) => entry.id === threadId);
      const project = thread
        ? hydrated.projects.find((entry) => entry.id === thread.projectId)
        : undefined;
      input.install({ threadId, thread, project });
      if (level === "history" && thread) {
        historyLoaded.add(threadId);
      }
      return thread;
    }

    return yield* Effect.fail(
      new Error(`Unable to hydrate thread '${threadId}' from a retained projection range.`),
    );
  });

  return { load };
}
