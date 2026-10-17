import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ThreadId,
} from "@bigbud/contracts";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  asMessageId,
  createHarness,
  registerProviderCommandReactorTestCleanup,
  waitFor,
} from "./ProviderCommandReactor.test.helpers.ts";
import { recordThreadTextGenerationStatus } from "../../git/Layers/InternalTextGeneration.status.ts";
import { recordTextGenerationRequestStage } from "../../git/Layers/InternalTextGeneration.requests.ts";
import { requestTextGenerationRetry } from "../../ws/wsRetryTextGeneration.ts";
import { resetThreadTitleLockForTests } from "../../orchestration-tools/ThreadTitleLock.ts";
import { recordTitleStage } from "./ProviderCommandReactorSessionOps.title.state.ts";
import type { SessionOpServices } from "./ProviderCommandReactorSessionOps.types.ts";

const threadId = ThreadId.makeUnsafe("thread-1");
type Harness = Awaited<ReturnType<typeof createHarness>>;
const readThread = async (harness: Harness) =>
  (await Effect.runPromise(harness.engine.getReadModel())).threads.find(
    (item) => item.id === threadId,
  )!;
async function acceptedRequest() {
  const harness = await createHarness({
    startReactor: false,
    serverSettingsOverrides: {
      textGenerationModelSelection: { provider: "codex", model: "explicit-model" },
    },
  });
  await Effect.runPromise(
    harness.engine.dispatch({
      type: "thread.turn.start",
      threadId,
      commandId: CommandId.makeUnsafe("fixture:unsent"),
      message: {
        messageId: asMessageId("fixture:user"),
        role: "user",
        text: "Investigate reconnect recovery",
        attachments: [],
      },
      runtimeMode: "approval-required",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      createdAt: new Date().toISOString(),
    }),
  );
  await Effect.runPromise(
    recordThreadTextGenerationStatus(harness.engine, threadId, "title", "failed"),
  );
  const sourceActivityId = (await readThread(harness)).activities.findLast(
    (item) => item.kind === "text-generation.failed",
  )!.id;
  const input = { threadId, operation: "title" as const, sourceActivityId };
  await Promise.all([
    Effect.runPromise(requestTextGenerationRetry(harness.engine, input)),
    Effect.runPromise(requestTextGenerationRetry(harness.engine, input)),
  ]);
  const request = (await readThread(harness)).activities.find(
    (item) => item.kind === "text-generation.retry-requested",
  )!;
  return { harness, input, request };
}

describe("durable metadata request recovery", () => {
  registerProviderCommandReactorTestCleanup();
  afterEach(resetThreadTitleLockForTests);
  it("retains final-fallback failure eligibility when a manual retry's delivery is ambiguous after restart", async () => {
    const { harness, request } = await acceptedRequest();
    await Effect.runPromise(
      recordTitleStage(
        { orchestrationEngine: harness.engine } as SessionOpServices,
        await readThread(harness),
        4,
        "failed",
      ),
    );
    await Effect.runPromise(
      recordTextGenerationRequestStage(harness.engine, threadId, request, "started"),
    );
    await harness.startReactor();
    await waitFor(async () =>
      (await readThread(harness)).activities.some(
        (item) => item.kind === "text-generation.request-settled",
      ),
    );
    const failure = (await readThread(harness)).activities.findLast(
      (item) => item.kind === "text-generation.failed",
    );
    expect(failure?.payload).toMatchObject({ operation: "title", finalFailure: true });
    expect(harness.generateThreadTitle).not.toHaveBeenCalled();
    expect(harness.sendTurn).not.toHaveBeenCalled();
  });
  it("uses durable command receipts to reject a second execution owner for the same request", async () => {
    const { harness, request } = await acceptedRequest();
    await Effect.runPromise(
      recordTextGenerationRequestStage(harness.engine, threadId, request, "started"),
    );
    const second = await Effect.runPromiseExit(
      recordTextGenerationRequestStage(harness.engine, threadId, request, "started"),
    );
    expect(second._tag).toBe("Failure");
    expect(harness.generateThreadTitle).not.toHaveBeenCalled();
  });

  it("bounds restart recovery to two metadata jobs without replaying any chat turns", async () => {
    const { harness } = await acceptedRequest();
    for (const number of [2, 3]) {
      const id = ThreadId.makeUnsafe(`thread-${number}`),
        createdAt = new Date().toISOString();
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.create",
          threadId: id,
          projectId: ProjectId.makeUnsafe("project-1"),
          commandId: CommandId.makeUnsafe(`fixture:create:${number}`),
          title: "New thread",
          modelSelection: { provider: "codex", model: "fixture" },
          runtimeMode: "approval-required",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          threadId: id,
          commandId: CommandId.makeUnsafe(`fixture:message:${number}`),
          message: {
            messageId: asMessageId(`fixture:message:${number}`),
            role: "user",
            text: "A synthetic metadata request",
            attachments: [],
          },
          runtimeMode: "approval-required",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt,
        }),
      );
      await Effect.runPromise(
        recordThreadTextGenerationStatus(harness.engine, id, "title", "failed"),
      );
      const current = (await Effect.runPromise(harness.engine.getReadModel())).threads.find(
        (item) => item.id === id,
      )!;
      await Effect.runPromise(
        requestTextGenerationRetry(harness.engine, {
          threadId: id,
          operation: "title",
          sourceActivityId: current.activities.findLast(
            (item) => item.kind === "text-generation.failed",
          )!.id,
        }),
      );
    }
    const release: Array<() => void> = [];
    harness.generateThreadTitle.mockImplementation(() =>
      Effect.promise(
        () =>
          new Promise<{ title: string }>((resolve) =>
            release.push(() => resolve({ title: "Recovered bounded request" })),
          ),
      ),
    );
    await harness.startReactor();
    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 2);
    expect(release).toHaveLength(2);
    release[0]!();
    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 3);
    release.forEach((finish) => finish());
    await waitFor(
      async () =>
        (await Effect.runPromise(harness.engine.getReadModel())).threads
          .flatMap((item) => item.activities)
          .filter((item) => item.kind === "text-generation.request-settled").length === 3,
    );
    expect(harness.sendTurn).not.toHaveBeenCalled();
  });

  it("recovers accepted-before-start requests once, including duplicate delivery after completion, without replaying chat", async () => {
    const { harness, input, request } = await acceptedRequest();
    expect(
      (await readThread(harness)).activities.filter(
        (item) => item.kind === "text-generation.retry-requested",
      ),
    ).toHaveLength(1);
    expect(harness.generateThreadTitle).not.toHaveBeenCalled();
    harness.generateThreadTitle.mockReturnValue(
      Effect.succeed({ title: "Recovered metadata title" }),
    );
    await harness.startReactor();
    await waitFor(async () =>
      (await readThread(harness)).activities.some(
        (item) => item.kind === "text-generation.request-settled",
      ),
    );
    expect((await readThread(harness)).title).toBe("Recovered metadata title");
    await Effect.runPromise(requestTextGenerationRetry(harness.engine, input));
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        threadId,
        commandId: CommandId.makeUnsafe("fixture:duplicate-delivery"),
        activity: request,
        createdAt: request.createdAt,
      }),
    );
    await harness.drain();
    expect(harness.generateThreadTitle).toHaveBeenCalledTimes(1);
    expect(harness.sendTurn).not.toHaveBeenCalled();
    expect(harness.startSession).not.toHaveBeenCalled();
  });

  it("does not automatically charge an ambiguous started request again after restart", async () => {
    const { harness, request } = await acceptedRequest();
    await Effect.runPromise(
      recordTextGenerationRequestStage(harness.engine, threadId, request, "started"),
    );
    await harness.startReactor();
    await waitFor(async () =>
      (await readThread(harness)).activities.some(
        (item) => item.kind === "text-generation.request-settled",
      ),
    );
    expect(harness.generateThreadTitle).not.toHaveBeenCalled();
    expect(harness.sendTurn).not.toHaveBeenCalled();
    expect(
      (await readThread(harness)).activities.findLast((item) =>
        ["text-generation.failed", "text-generation.completed"].includes(item.kind),
      )?.kind,
    ).toBe("text-generation.failed");
  });

  it.each(["workspace", "title"])(
    "settles a stale %s request without a provider call",
    async (change) => {
      const { harness, request } = await acceptedRequest();
      if (change === "workspace") {
        // A recovered durable snapshot can name a prior workspace. The transfer itself belongs to worktree tests.
        const payload = request.payload as { context: { cwd: string } };
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.activity.append",
            threadId,
            commandId: CommandId.makeUnsafe("fixture:stale-context"),
            activity: {
              ...request,
              payload: { ...payload, context: { ...payload.context, cwd: "/earlier-workspace" } },
            },
            createdAt: request.createdAt,
          }),
        );
      } else {
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.meta.update",
            commandId: CommandId.makeUnsafe("fixture:context-change"),
            threadId,
            title: "User-owned title",
          }),
        );
      }
      await harness.startReactor();
      await waitFor(async () =>
        (await readThread(harness)).activities.some(
          (item) => item.kind === "text-generation.request-settled",
        ),
      );
      expect(harness.generateThreadTitle).not.toHaveBeenCalled();
      expect(harness.sendTurn).not.toHaveBeenCalled();
      if (change === "title") expect((await readThread(harness)).title).toBe("User-owned title");
    },
  );
});
