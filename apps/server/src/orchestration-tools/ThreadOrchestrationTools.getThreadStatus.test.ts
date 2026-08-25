import { ProjectId, ThreadId } from "@bigbud/contracts";
import { Effect, Option } from "effect";
import { describe, expect, it, vi } from "vitest";

import { getThreadStatusViaOrchestration } from "./ThreadOrchestrationTools.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ThreadDelegationRepositoryShape } from "../persistence/Services/ThreadDelegations.ts";

const callerThreadId = ThreadId.makeUnsafe("caller-thread");
const childThreadId = ThreadId.makeUnsafe("child-thread");
const unrelatedThreadId = ThreadId.makeUnsafe("unrelated-thread");
const callerProjectId = ProjectId.makeUnsafe("caller-project");
const otherProjectId = ProjectId.makeUnsafe("other-project");

const makeThread = (id: ThreadId, projectId: ProjectId, overrides = {}) => ({
  id,
  projectId,
  title: id,
  archivedAt: null,
  deletedAt: null,
  updatedAt: new Date().toISOString(),
  activities: [],
  proposedPlans: [],
  messages: [],
  session: null,
  latestTurn: null,
  interactionMode: "default",
  ...overrides,
});

const makeRepository = (childThreadId: ThreadId, callerThreadId: ThreadId) =>
  ({
    findDirectByChild: vi.fn(() =>
      Effect.succeed(Option.some({ callerThreadId, childThreadId } as never)),
    ),
  }) as unknown as ThreadDelegationRepositoryShape;

const run = (input: Parameters<typeof getThreadStatusViaOrchestration>[0]) =>
  Effect.runPromise(getThreadStatusViaOrchestration(input));

describe("getThreadStatusViaOrchestration", () => {
  it("allows a delegated child in another project", async () => {
    const repository = makeRepository(childThreadId, callerThreadId);
    const engine = {
      getReadModel: () =>
        Effect.succeed({
          threads: [
            makeThread(callerThreadId, callerProjectId),
            makeThread(childThreadId, otherProjectId),
          ],
          projects: [],
        }),
    } as unknown as OrchestrationEngineShape;

    const status = await run({
      orchestrationEngine: engine,
      threadDelegationRepository: repository,
      callerThreadId,
      threadId: childThreadId,
    });

    expect(status.threadId).toBe(childThreadId);
    expect(repository.findDirectByChild).toHaveBeenCalledWith({ childThreadId });
  });

  it("rejects an unrelated cross-project thread", async () => {
    const repository = makeRepository(unrelatedThreadId, unrelatedThreadId);
    const engine = {
      getReadModel: () =>
        Effect.succeed({
          threads: [
            makeThread(callerThreadId, callerProjectId),
            makeThread(childThreadId, otherProjectId),
          ],
          projects: [],
        }),
    } as unknown as OrchestrationEngineShape;

    await expect(
      run({
        orchestrationEngine: engine,
        threadDelegationRepository: repository,
        callerThreadId,
        threadId: childThreadId,
      }),
    ).rejects.toThrow("not accessible");
  });

  it("keeps archived and same-project threads readable, but rejects deleted threads", async () => {
    const repository = makeRepository(childThreadId, callerThreadId);
    const sameProjectEngine = {
      getReadModel: () =>
        Effect.succeed({
          threads: [
            makeThread(callerThreadId, callerProjectId),
            makeThread(childThreadId, callerProjectId),
          ],
          projects: [],
        }),
    } as unknown as OrchestrationEngineShape;
    await expect(
      run({
        orchestrationEngine: sameProjectEngine,
        threadDelegationRepository: repository,
        callerThreadId,
        threadId: childThreadId,
      }),
    ).resolves.toMatchObject({ workflowStatus: "idle" });
    expect(repository.findDirectByChild).not.toHaveBeenCalled();

    const archived = makeThread(childThreadId, otherProjectId, {
      archivedAt: new Date().toISOString(),
    });
    const engine = {
      getReadModel: () =>
        Effect.succeed({
          threads: [makeThread(callerThreadId, callerProjectId), archived],
          projects: [],
        }),
    } as unknown as OrchestrationEngineShape;

    await expect(
      run({
        orchestrationEngine: engine,
        threadDelegationRepository: repository,
        callerThreadId,
        threadId: childThreadId,
      }),
    ).resolves.toMatchObject({ workflowStatus: "archived" });

    const deletedEngine = {
      getReadModel: () =>
        Effect.succeed({
          threads: [
            makeThread(callerThreadId, callerProjectId),
            makeThread(childThreadId, otherProjectId, { deletedAt: new Date().toISOString() }),
          ],
          projects: [],
        }),
    } as unknown as OrchestrationEngineShape;
    await expect(
      run({
        orchestrationEngine: deletedEngine,
        threadDelegationRepository: repository,
        callerThreadId,
        threadId: childThreadId,
      }),
    ).rejects.toThrow("was not found");
  });
});
