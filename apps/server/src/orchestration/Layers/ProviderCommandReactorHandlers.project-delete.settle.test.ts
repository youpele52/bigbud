/**
 * D-4 regression: the project-delete waiter must notice a cascaded thread deletion that commits
 * between its first read-model check and its domain-event subscription, and must not depend on
 * a wake-up at all (a pruned or dead replay stream). Runs the real engine on SQLite; the
 * deletion is committed inside the first check, after it read the read model, so the window is
 * hit exactly on every run.
 */
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type OrchestrationEvent,
  ThreadId,
} from "@bigbud/contracts";
import { Duration, Effect, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { asProjectId, createOrchestrationSystem, now } from "./OrchestrationEngine.test.helpers.ts";
import { waitForProjectThreadsToSettle } from "./ProviderCommandReactorHandlers.project-delete.settle.ts";

const projectId = asProjectId("project-d4-settle");
const threadId = ThreadId.makeUnsafe("thread-d4-settle");
const modelSelection = { provider: "codex", model: "gpt-5-codex" } as const;
const NO_TIMER = Duration.seconds(60);
const WAIT_TIMEOUT = Duration.seconds(3);

type System = Awaited<ReturnType<typeof createOrchestrationSystem>>;
let system: System | undefined;

afterEach(async () => {
  await system?.dispose();
  system = undefined;
});

async function deletingProject(): Promise<System> {
  system = await createOrchestrationSystem();
  const createdAt = now();
  await system.run(
    system.engine.dispatch({
      type: "project.create",
      commandId: CommandId.makeUnsafe("d4-project-create"),
      projectId,
      title: "D-4",
      workspaceRoot: "/tmp/project-d4-settle",
      defaultModelSelection: modelSelection,
      createdAt,
    }),
  );
  await system.run(
    system.engine.dispatch({
      type: "thread.create",
      commandId: CommandId.makeUnsafe("d4-thread-create"),
      threadId,
      projectId,
      title: "Cascaded",
      modelSelection,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt,
    }),
  );
  await system.run(
    system.engine.dispatch({
      type: "thread.delete",
      commandId: CommandId.makeUnsafe("d4-thread-delete"),
      threadId,
    }),
  );
  return system;
}

/** Reads the real read model, then commits the thread's `thread.deleted` before returning. */
function resolverCommittingInWindow(target: System) {
  let commits = 0;
  return {
    commits: () => commits,
    resolveThreadsByProject: () =>
      Effect.gen(function* () {
        const readModel = yield* target.engine.getReadModel();
        const threads = readModel.threads.filter((thread) => thread.projectId === projectId);
        if (commits === 0) {
          commits += 1;
          yield* target.engine
            .dispatch({
              type: "thread.delete.finalize",
              commandId: CommandId.makeUnsafe("d4-thread-finalize"),
              threadId,
              createdAt: now(),
            })
            .pipe(Effect.orDie);
        }
        return threads;
      }),
  };
}

async function settle(
  target: System,
  events: Stream.Stream<OrchestrationEvent>,
  recheck: Duration.Duration,
) {
  const resolver = resolverCommittingInWindow(target);
  const startedAt = Date.now();
  const result = await target.run(
    waitForProjectThreadsToSettle({
      projectId,
      resolveThreadsByProject: resolver.resolveThreadsByProject,
      events,
      timeout: WAIT_TIMEOUT,
      recheckInterval: recheck,
    }),
  );
  expect(resolver.commits()).toBe(1);
  return { result, elapsedMs: Date.now() - startedAt };
}

describe("waitForProjectThreadsToSettle (D-4)", () => {
  it("wakes on a deletion committed between the first check and the subscription", async () => {
    const target = await deletingProject();
    // The timer is out of reach: only the domain-event wake-up can finish this wait.
    const { result, elapsedMs } = await settle(target, target.engine.streamDomainEvents, NO_TIMER);
    expect(result).toEqual({ ok: true });
    expect(elapsedMs).toBeLessThan(2_000);
    const thread = (await target.run(target.engine.getReadModel())).threads.find(
      (candidate) => candidate.id === threadId,
    );
    expect(thread === undefined || thread.deletedAt !== null).toBe(true);
  });

  it("re-checks on the timer when no wake-up ever arrives", async () => {
    const target = await deletingProject();
    const { result, elapsedMs } = await settle(target, Stream.never, Duration.millis(100));
    expect(result).toEqual({ ok: true });
    expect(elapsedMs).toBeLessThan(2_000);
  });

  it("keeps re-checking after the wake-up stream dies on a replay gap", async () => {
    const target = await deletingProject();
    const { result } = await settle(
      target,
      Stream.die(new Error("orchestration domain event reactor replay gap")),
      Duration.millis(100),
    );
    expect(result).toEqual({ ok: true });
  });

  it("still aborts with the timeout detail when the threads never settle", async () => {
    const target = await deletingProject();
    const result = await target.run(
      waitForProjectThreadsToSettle({
        projectId,
        resolveThreadsByProject: () =>
          target.engine
            .getReadModel()
            .pipe(Effect.map((model) => model.threads.filter((t) => t.projectId === projectId))),
        events: target.engine.streamDomainEvents,
        timeout: Duration.millis(300),
        recheckInterval: Duration.millis(50),
      }),
    );
    expect(result).toEqual({
      ok: false,
      detail: `Timed out waiting for threads in project '${projectId}' to delete.`,
    });
  });
});
