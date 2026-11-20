import type {
  OrchestrationEvent,
  OrchestrationProject,
  OrchestrationReadModel,
  OrchestrationThread,
  ProjectId,
  ThreadId,
} from "@bigbud/contracts";
import { Effect, Option } from "effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import type { OrchestrationEventStoreShape } from "../../persistence/Services/OrchestrationEventStore.ts";
import type { ProjectionOperationalStateQueryShape } from "../Services/ProjectionOperationalStateQuery.ts";
import { projectEvent } from "../projector.ts";
import type { ThreadResidency } from "./OrchestrationEngine.residency.ts";

export type ThreadStateLevel = "operational" | "history";

/**
 * Installs hydrated state into the engine read model. With `threadId` the thread is replaced (or
 * removed when `thread` is undefined); without it only `project` is installed.
 */
export type ThreadStateInstall = (input: {
  threadId: ThreadId | undefined;
  thread: OrchestrationThread | undefined;
  project: OrchestrationProject | undefined;
}) => void;

const HYDRATION_ATTEMPTS = 3;

/**
 * The one "ensure hydrated" helper for the engine read model. The startup window holds only
 * operational threads and their projects, so every aggregate a command or a pre-dispatch lookup
 * references is loaded here from durable projections (plus the events after them) on demand.
 */
export function makeThreadStateHydrator(input: {
  readonly query: ProjectionOperationalStateQueryShape;
  readonly eventStore: OrchestrationEventStoreShape;
  readonly readModel: () => OrchestrationReadModel;
  readonly install: ThreadStateInstall;
  /** Records each access so eviction picks only idle threads. */
  readonly residency?: ThreadResidency;
  /** Removes evicted threads from the engine read model. */
  readonly evict?: (threadIds: ReadonlySet<ThreadId>) => void;
}) {
  const historyLoaded = new Set<ThreadId>();
  const touch = (threadId: ThreadId) => input.residency?.touch(threadId);

  /**
   * The resident thread when it already satisfies `level`, without a barrier or SQL. Callers
   * that miss must call `load` under the command barrier.
   */
  const peek = (threadId: ThreadId, level: ThreadStateLevel) => {
    const current = input.readModel().threads.find((thread) => thread.id === threadId);
    if (!current || (level === "history" && !historyLoaded.has(threadId))) return undefined;
    touch(threadId);
    return current;
  };

  /** Replays retained events onto a projection snapshot; `undefined` means the range moved. */
  const replayOnto = Effect.fn("OrchestrationEngine.replayHydration")(function* (
    snapshot: OrchestrationReadModel,
  ) {
    let hydrated = snapshot;
    let replayFrom = hydrated.snapshotSequence;
    for (;;) {
      const replay = yield* input.eventStore.readReplay(replayFrom);
      if (replay.availability === "gap") return undefined;
      for (const event of replay.events as ReadonlyArray<OrchestrationEvent>) {
        hydrated = yield* projectEvent(hydrated, event);
      }
      if (replay.complete) return hydrated;
      const nextSequence = replay.events.at(-1)?.sequence;
      if (nextSequence === undefined || nextSequence <= replayFrom) return undefined;
      replayFrom = nextSequence;
    }
  });

  const unretained = (kind: string, id: string) =>
    Effect.fail(new Error(`Unable to hydrate ${kind} '${id}' from a retained projection range.`));

  const load = Effect.fn("OrchestrationEngine.ensureThreadState")(function* (
    threadId: ThreadId,
    level: ThreadStateLevel,
  ) {
    const current = peek(threadId, level);
    if (current) return current;
    // An access by id counts even before the thread exists: a command creating it is prepared
    // here, so its residency starts now (the sweep drops entries for ids never installed).
    touch(threadId);

    for (let attempt = 0; attempt < HYDRATION_ATTEMPTS; attempt += 1) {
      const queried = yield* level === "history"
        ? input.query.getFullThreadHistory(threadId)
        : input.query.getThreadOperationalState(threadId);
      if (Option.isNone(queried)) {
        input.install({ threadId, thread: undefined, project: undefined });
        historyLoaded.delete(threadId);
        return undefined;
      }
      const hydrated = yield* replayOnto(queried.value);
      if (hydrated === undefined) continue;

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

    return yield* unretained("thread", threadId);
  });

  /** A project the read model already holds is kept current by every committed event. */
  const loadProject = Effect.fn("OrchestrationEngine.ensureProjectState")(function* (
    projectId: ProjectId,
  ) {
    const current = input.readModel().projects.find((project) => project.id === projectId);
    if (current) return current;
    for (let attempt = 0; attempt < HYDRATION_ATTEMPTS; attempt += 1) {
      const queried = yield* input.query.getProjectOperationalState(projectId);
      if (Option.isNone(queried)) return undefined;
      const hydrated = yield* replayOnto(queried.value);
      if (hydrated === undefined) continue;
      const project = hydrated.projects.find((entry) => entry.id === projectId);
      if (project) input.install({ threadId: undefined, thread: undefined, project });
      return project;
    }
    return yield* unretained("project", projectId);
  });

  /** Every project that is not deleted and uses this workspace root. */
  const loadWorkspaceProjects = Effect.fn("OrchestrationEngine.ensureWorkspaceProjects")(function* (
    workspaceRoot: string,
  ) {
    const ids = yield* input.query.listProjectIdsByWorkspaceRoot(workspaceRoot);
    const projects: Array<OrchestrationProject> = [];
    for (const id of ids) {
      const project = yield* loadProject(id);
      if (project) projects.push(project);
    }
    return projects;
  });

  /** The project and every thread of it that is not deleted (for project-wide invariants). */
  const loadProjectWithThreads = Effect.fn("OrchestrationEngine.ensureProjectThreads")(function* (
    projectId: ProjectId,
    level: ThreadStateLevel,
  ) {
    const project = yield* loadProject(projectId);
    for (const threadId of yield* input.query.listProjectThreadIds(projectId)) {
      yield* load(threadId, level);
    }
    return project;
  });

  /** The root and its live descendants (subtree deletion must see every one of them). */
  const loadThreadSubtree = Effect.fn("OrchestrationEngine.ensureThreadSubtree")(function* (
    rootThreadId: ThreadId,
    level: ThreadStateLevel,
  ) {
    yield* load(rootThreadId, level);
    if (input.query.listThreadSubtreeIds === undefined) return;
    for (const threadId of yield* input.query.listThreadSubtreeIds(rootThreadId)) {
      yield* load(threadId, level);
    }
  });

  /** Drops threads from the read model; the next access rehydrates them. Barrier required. */
  const evict = (threadIds: ReadonlySet<ThreadId>) => {
    if (threadIds.size === 0) return;
    for (const threadId of threadIds) {
      historyLoaded.delete(threadId);
      input.residency?.forget(threadId);
    }
    input.evict?.(threadIds);
  };

  return {
    peek,
    load,
    loadProject,
    loadWorkspaceProjects,
    loadProjectWithThreads,
    loadThreadSubtree,
    evict,
  };
}

export type ThreadStateHydrator = ReturnType<typeof makeThreadStateHydrator>;
export type ThreadStateHydrationError = ProjectionRepositoryError | Error;
