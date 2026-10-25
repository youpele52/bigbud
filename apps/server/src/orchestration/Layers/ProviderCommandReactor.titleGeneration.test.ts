import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  TextGenerationError,
  ThreadId,
} from "@bigbud/contracts";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { resetThreadTitleLockForTests } from "../../orchestration-tools/ThreadTitleLock.ts";
import {
  asMessageId,
  createHarness,
  registerProviderCommandReactorTestCleanup,
  waitFor,
} from "./ProviderCommandReactor.test.helpers.ts";

const threadId = ThreadId.makeUnsafe("thread-1");
type Harness = Awaited<ReturnType<typeof createHarness>>;
const text = "Please investigate reconnect failures after restarting the session.";
const configuredHarness = () =>
  createHarness({
    serverSettingsOverrides: {
      textGenerationModelSelection: { provider: "codex", model: "explicit-model" },
    },
  });
const start = (harness: Harness, titleSeed?: string) =>
  Effect.runPromise(
    harness.engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.makeUnsafe(`test:${crypto.randomUUID()}`),
      threadId,
      message: {
        messageId: asMessageId(`user:${crypto.randomUUID()}`),
        role: "user",
        text,
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: new Date().toISOString(),
      modelSelection: { provider: "codex", model: "gpt-5.4" },
      ...(titleSeed ? { titleSeed } : {}),
    }),
  );
const readThread = async (harness: Harness) =>
  (await Effect.runPromise(harness.engine.getReadModel())).threads.find(
    (thread) => thread.id === threadId,
  )!;
const hasStatus = async (harness: Harness, kind: string) =>
  (await readThread(harness)).activities.some((activity) => activity.kind === kind);

describe("ProviderCommandReactor title generation", () => {
  registerProviderCommandReactorTestCleanup();
  afterEach(resetThreadTitleLockForTests);

  it("generates a first-turn title when an override is explicitly configured", async () => {
    const harness = await configuredHarness();
    harness.generateThreadTitle.mockReturnValue(Effect.succeed({ title: "Generated title" }));
    await start(harness);
    await waitFor(async () => (await readThread(harness)).title === "Generated title");
    expect(harness.generateThreadTitle).toHaveBeenCalledTimes(1);
    await waitFor(() => hasStatus(harness, "text-generation.completed"));
  });

  it("retries the normal policy once, then waits without warning or replaying chat", async () => {
    const harness = await configuredHarness();
    harness.generateThreadTitle.mockReturnValue(
      Effect.fail(
        new TextGenerationError({ operation: "generateThreadTitle", detail: "Unsupported model" }),
      ),
    );
    await start(harness);
    await waitFor(async () =>
      (await readThread(harness)).activities.some(
        (item) =>
          item.kind === "text-generation.title-stage" &&
          (item.payload as { stage?: number; state?: string }).stage === 2 &&
          (item.payload as { state?: string }).state === "failed",
      ),
    );
    expect(harness.generateThreadTitle).toHaveBeenCalledTimes(2);
    expect(await hasStatus(harness, "text-generation.failed")).toBe(false);
    expect((await readThread(harness)).title).toBe("Please investigate reconn...");
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
  });

  it("does not overwrite the fallback title with a weak AI placeholder", async () => {
    const harness = await configuredHarness();
    harness.generateThreadTitle.mockReturnValue(Effect.succeed({ title: "New thread" }));
    await start(harness);
    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 2);
    expect((await readThread(harness)).title).toBe("Please investigate reconn...");
    expect(harness.generateThreadTitle).toHaveBeenCalledTimes(2);
  });

  it("waits for first success without an override, then generates with success evidence", async () => {
    const harness = await createHarness();
    harness.generateThreadTitle.mockReturnValue(Effect.succeed({ title: "Deferred title" }));
    await start(harness, "Caller-supplied fallback title");
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.generateThreadTitle).not.toHaveBeenCalled();
    const createdAt = new Date().toISOString();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe("test:success-model"),
        threadId,
        createdAt,
        activity: {
          id: EventId.makeUnsafe("test:success-model"),
          kind: "text-generation.model-succeeded",
          tone: "info",
          summary: "Successful model",
          payload: { provider: "claudeAgent", model: "proven-model" },
          turnId: null,
          createdAt,
        },
      }),
    );
    await waitFor(async () => (await readThread(harness)).title === "Deferred title");
    expect(harness.generateThreadTitle.mock.calls[0]?.[0].successfulModelSelection).toEqual({
      provider: "claudeAgent",
      model: "proven-model",
    });
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
  });

  it("stops automatically after the immediate second attempt succeeds", async () => {
    const harness = await configuredHarness();
    harness.generateThreadTitle
      .mockReturnValueOnce(
        Effect.fail(
          new TextGenerationError({ operation: "generateThreadTitle", detail: "Failure" }),
        ),
      )
      .mockReturnValue(Effect.succeed({ title: "Recovered title" }));
    await start(harness);
    await waitFor(async () => (await readThread(harness)).title === "Recovered title");
    expect(harness.generateThreadTitle).toHaveBeenCalledTimes(2);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
  });

  it("never replaces a manually assigned title", async () => {
    const harness = await configuredHarness();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("user:rename"),
        threadId,
        title: "Keep my title",
      }),
    );
    await start(harness);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.generateThreadTitle).not.toHaveBeenCalled();
    expect((await readThread(harness)).title).toBe("Keep my title");
  });

  it("does not overwrite an agent rename while generation is running", async () => {
    const harness = await configuredHarness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    harness.generateThreadTitle.mockReturnValue(
      Effect.promise(async () => {
        await gate;
        return { title: "Generated later" };
      }),
    );
    await start(harness);
    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 1);
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("agent:rename"),
        threadId,
        title: "Summer sun",
      }),
    );
    release();
    await harness.drain();
    expect((await readThread(harness)).title).toBe("Summer sun");
  });
});
