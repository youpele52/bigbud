import type {
  OrchestrationCommand,
  OrchestrationProject,
  OrchestrationThread,
  ProjectId,
  ThreadId,
} from "@bigbud/contracts";
import { Effect } from "effect";

import { forkLineageThreadIds } from "../deciderThreads.fork.logic.ts";
import { commandToAggregateRef } from "./OrchestrationEngine.commandProcessing.ts";

type ThreadLevel = "operational" | "history";

/** The engine's hydrator (`OrchestrationEngine.hydration.ts`); test doubles may omit projects. */
type ThreadStateHydrator<HydrationError> = {
  readonly load: (
    threadId: ThreadId,
    level: ThreadLevel,
  ) => Effect.Effect<OrchestrationThread | undefined, HydrationError>;
  readonly loadProject?: (
    projectId: ProjectId,
  ) => Effect.Effect<OrchestrationProject | undefined, HydrationError>;
  readonly loadWorkspaceProjects?: (
    workspaceRoot: string,
  ) => Effect.Effect<ReadonlyArray<OrchestrationProject>, HydrationError>;
  readonly loadProjectWithThreads?: (
    projectId: ProjectId,
    level: ThreadLevel,
  ) => Effect.Effect<OrchestrationProject | undefined, HydrationError>;
};

/**
 * Loads every aggregate the decider reads for `command` before it runs. The startup read model
 * holds only operational threads and their projects, so a settled thread, an idle project, or
 * the threads a project-wide invariant scans are hydrated from durable projections here.
 */
export function makePrepareCommandState<HydrationError>(input: {
  readonly threadStateHydrator: ThreadStateHydrator<HydrationError> | null;
}) {
  return (command: OrchestrationCommand): Effect.Effect<void, HydrationError> => {
    const hydrator = input.threadStateHydrator;
    if (hydrator === null) return Effect.void;
    const project = (projectId: ProjectId): Effect.Effect<void, HydrationError> =>
      hydrator.loadProject ? Effect.asVoid(hydrator.loadProject(projectId)) : Effect.void;
    const projectWithThreads = (
      projectId: ProjectId,
      level: ThreadLevel,
    ): Effect.Effect<void, HydrationError> =>
      hydrator.loadProjectWithThreads
        ? Effect.asVoid(hydrator.loadProjectWithThreads(projectId, level))
        : Effect.void;
    // Workspace-root uniqueness compares against every live project using that root.
    const workspaceProjects = (
      workspaceRoot: string | null | undefined,
    ): Effect.Effect<void, HydrationError> =>
      workspaceRoot && hydrator.loadWorkspaceProjects
        ? Effect.asVoid(hydrator.loadWorkspaceProjects(workspaceRoot))
        : Effect.void;
    switch (command.type) {
      case "project.create":
        return Effect.andThen(project(command.projectId), workspaceProjects(command.workspaceRoot));
      case "project.reconfigure":
        // Workspace change safety and idleness read every thread, with history (worktrees).
        return Effect.andThen(
          projectWithThreads(command.projectId, "history"),
          workspaceProjects(command.workspaceRoot),
        );
      case "project.meta.update":
        // A folder change scans the project's threads for active work and retained worktrees.
        return command.workspaceRoot !== undefined
          ? projectWithThreads(command.projectId, "operational")
          : project(command.projectId);
      case "project.delete":
      case "project.delete.finalize":
        // The cascade and the finalize check enumerate the project's live threads.
        return projectWithThreads(command.projectId, "operational");
      case "project.delete.abort":
        return project(command.projectId);
    }
    if (command.type === "thread.create") {
      return Effect.gen(function* () {
        yield* project(command.projectId);
        yield* hydrator.load(command.threadId, "operational");
        if (
          command.parentThread !== undefined &&
          command.parentThread.threadId !== command.threadId
        ) {
          yield* hydrator.load(command.parentThread.threadId, "operational");
        }
      });
    }
    if (command.type === "thread.fork") {
      // The fork copies settled history from its source, so the source needs full history.
      return Effect.gen(function* () {
        yield* hydrator.load(command.threadId, "operational");
        const source = yield* hydrator.load(command.sourceThreadId, "history");
        // Earlier forks decide idempotency only while they still exist (deleted ones do not).
        for (const forkThreadId of new Set(source ? forkLineageThreadIds(source) : [])) {
          if (forkThreadId !== command.threadId) {
            yield* hydrator.load(forkThreadId, "operational");
          }
        }
      });
    }
    const aggregate = commandToAggregateRef(command);
    if (aggregate.aggregateKind !== "thread") return Effect.void;
    const targetThreadId = aggregate.aggregateId as ThreadId;
    const sourceThreadId =
      command.type === "thread.turn.start" || command.type === "thread.message.submit"
        ? command.sourceProposedPlan?.threadId
        : undefined;
    const historyRequired =
      (command.type === "thread.meta.update" &&
        (command.title !== undefined || command.elevatorSummary !== undefined)) ||
      command.type === "thread.turn.start" ||
      (command.type === "thread.message.submit" &&
        command.message.replyToMessageId !== undefined) ||
      sourceThreadId === targetThreadId ||
      command.type === "thread.checkpoint.revert" ||
      command.type === "thread.revert.complete" ||
      // The startup window omits idle threads' activities; a held choice must be visible.
      command.type === "thread.delegation.model-choice.hold" ||
      command.type === "thread.delegation.model-choice.expire" ||
      command.type === "thread.delegation.model-choice.pick";
    return Effect.gen(function* () {
      yield* hydrator.load(targetThreadId, historyRequired ? "history" : "operational");
      if (sourceThreadId !== undefined && sourceThreadId !== targetThreadId) {
        yield* hydrator.load(sourceThreadId, "history");
      }
    });
  };
}
