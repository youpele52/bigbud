import { MessageId, ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { Effect, Option } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ThreadDelegationRepositoryShape } from "../persistence/Services/ThreadDelegations.ts";
import { renameThreadViaOrchestration } from "./ThreadOrchestrationTools.rename.ts";
import { isThreadTitleLocked, resetThreadTitleLockForTests } from "./ThreadTitleLock.ts";

const callerId = ThreadId.makeUnsafe("caller");
const targetId = ThreadId.makeUnsafe("target");
const projectId = ProjectId.makeUnsafe("project");
const otherProject = ProjectId.makeUnsafe("other-project");

function harness(
  options: {
    foreign?: boolean;
    delegatedBy?: ThreadId | undefined;
    callerMissing?: boolean;
    targetMissing?: boolean;
    callerDeleted?: boolean;
    targetDeleted?: boolean;
    callerDeleting?: boolean;
    targetDeleting?: boolean;
  } = {},
) {
  const dispatch = vi.fn(() => Effect.succeed({ sequence: 1 }));
  const repository = {
    findDirectByChild: vi.fn(() =>
      Effect.succeed(
        options.delegatedBy
          ? Option.some({ callerThreadId: options.delegatedBy, childThreadId: targetId })
          : Option.none(),
      ),
    ),
  } as unknown as ThreadDelegationRepositoryShape;
  const thread = (id: ThreadId, project: ProjectId, deleted: boolean, deleting: boolean) => ({
    id,
    projectId: project,
    deletedAt: deleted ? "now" : null,
    deletingAt: deleting ? "now" : null,
  });
  const engine = {
    dispatch,
    getReadModel: () =>
      Effect.succeed({
        threads: [
          ...(!options.callerMissing
            ? [thread(callerId, projectId, !!options.callerDeleted, !!options.callerDeleting)]
            : []),
          ...(!options.targetMissing
            ? [
                thread(
                  targetId,
                  options.foreign ? otherProject : projectId,
                  !!options.targetDeleted,
                  !!options.targetDeleting,
                ),
              ]
            : []),
        ],
      }),
  } as unknown as OrchestrationEngineShape;
  const rename = (
    args: Partial<Omit<Parameters<typeof renameThreadViaOrchestration>[0], "targetThreadId">> & {
      targetThreadId?: ThreadId | undefined;
    } = {},
  ) => {
    const { targetThreadId: selected, ...remaining } = { targetThreadId: targetId, ...args };
    return Effect.runPromise(
      renameThreadViaOrchestration({
        orchestrationEngine: engine,
        threadDelegationRepository: repository,
        threadId: callerId,
        ...(selected !== undefined ? { targetThreadId: selected } : {}),
        title: " ohno ",
        ...remaining,
      }),
    );
  };
  return { dispatch, repository, rename };
}

afterEach(resetThreadTitleLockForTests);

it("defaults to current thread and locks the actual canonical target", async () => {
  const own = harness();
  await expect(own.rename({ targetThreadId: undefined })).resolves.toMatchObject({
    title: "ohno",
    threadId: callerId,
  });
  expect(own.dispatch).toHaveBeenCalledWith(
    expect.objectContaining({ threadId: callerId, title: "ohno", type: "thread.meta.update" }),
  );
  resetThreadTitleLockForTests();
  const other = harness();
  await expect(other.rename()).resolves.toMatchObject({ title: "ohno", threadId: targetId });
  expect(isThreadTitleLocked(targetId)).toBe(true);
  expect(isThreadTitleLocked(callerId)).toBe(false);
  expect(other.repository.findDirectByChild).not.toHaveBeenCalled();
});

it("allows directly delegated cross-project children, not foreign or indirect targets", async () => {
  await expect(harness({ foreign: true, delegatedBy: callerId }).rename()).resolves.toMatchObject({
    threadId: targetId,
  });
  resetThreadTitleLockForTests();
  for (const delegatedBy of [undefined, targetId]) {
    const denied = harness({ foreign: true, delegatedBy });
    await expect(denied.rename()).rejects.toThrow("not accessible");
    expect(denied.dispatch).not.toHaveBeenCalled();
    expect(isThreadTitleLocked(targetId)).toBe(false);
  }
});

it.each([
  { callerMissing: true },
  { targetMissing: true },
  { callerDeleted: true },
  { targetDeleted: true },
  { callerDeleting: true },
  { targetDeleting: true },
])("rejects missing/deleted/deleting participants: %j", async (options) => {
  const denied = harness(options);
  await expect(denied.rename()).rejects.toThrow(/not found|being deleted/);
  expect(denied.dispatch).not.toHaveBeenCalled();
  expect(isThreadTitleLocked(targetId)).toBe(false);
});

it.each([
  { title: " " },
  { title: "x".repeat(201) },
  { targetThreadId: " " as ThreadId },
  { invocationId: "only-one" },
  { sourceMessageId: MessageId.makeUnsafe("only-one") },
])("rejects malformed rename inputs: %j", async (args) => {
  const denied = harness();
  await expect(denied.rename(args)).rejects.toThrow();
  expect(denied.dispatch).not.toHaveBeenCalled();
});

it("uses stable caller/source/invocation identity, without treating equal titles as evidence", async () => {
  const { rename, dispatch } = harness();
  const args = { invocationId: "tool-call", sourceMessageId: MessageId.makeUnsafe("user-message") };
  const first = await rename(args);
  const retry = await rename(args);
  expect(retry.commandId).toBe(first.commandId);
  expect(dispatch).toHaveBeenCalledTimes(2); // engine receipts, not helper heuristics, arbitrate replay
  expect((await rename({ ...args, invocationId: "next-call" })).commandId).not.toBe(
    first.commandId,
  );
  expect((await rename({ ...args, threadId: targetId })).commandId).not.toBe(first.commandId);
});
