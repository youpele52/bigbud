import { DEFAULT_SERVER_SETTINGS, MessageId, ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import { expect, it } from "vitest";

import {
  getThreadOrchestrationToolDispatcher,
  getThreadToolModelSources,
  setThreadToolModelSources,
} from "../../orchestration-tools/ThreadOrchestrationToolDispatcher.ts";
import { provider } from "../../orchestration-tools/ThreadOrchestrationTools.modelChoice.test.helpers.ts";
import { ExactDelegatedAcpEffort } from "../../provider/acp/acpSessionEffort.ts";
import {
  createHarness,
  registerProviderCommandReactorTestCleanup,
  waitFor,
} from "./ProviderCommandReactor.test.helpers.ts";

registerProviderCommandReactorTestCleanup();

it("carries the committed delegated tier through provider startup and first-send effects", async () => {
  const selection = { provider: "cursor", model: "synthetic" } as const;
  const observed: Array<string | undefined> = [];
  const captureEffort = ExactDelegatedAcpEffort.asEffect().pipe(
    Effect.tap((effort) => Effect.sync(() => observed.push(effort))),
  );
  const harness = await createHarness({
    threadModelSelection: selection,
    overrideProvider: (service) => ({
      ...service,
      startSession: (threadId, request) =>
        captureEffort.pipe(Effect.andThen(service.startSession(threadId, request))),
      sendTurn: (request) => captureEffort.pipe(Effect.andThen(service.sendTurn(request))),
    }),
  });
  const prior = getThreadToolModelSources();
  setThreadToolModelSources({
    getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
    getProviders: Effect.succeed([
      provider("cursor", {}, [
        {
          slug: selection.model,
          capabilities: {
            reasoningEffortLevels: [{ value: "xhigh", label: "Extra high" }],
            effortMetadataOrigin: "live",
            effortMetadataStatus: "verified-supported",
            supportsFastMode: false,
            supportsThinkingToggle: false,
            contextWindowOptions: [],
            promptInjectedEffortLevels: [],
          },
        },
      ]),
    ]),
    listRecent: () => Effect.succeed([]),
    hasInteractiveClient: () => false,
  });
  try {
    const createThread = getThreadOrchestrationToolDispatcher()?.createThread;
    if (!createThread) throw new Error("Missing real delegation dispatcher");
    await Effect.runPromise(
      createThread({
        callerThreadId: ThreadId.makeUnsafe("thread-1"),
        sourceMessageId: MessageId.makeUnsafe("delegated-acp-source"),
        invocationId: "delegated-acp-tool",
        title: "Child",
        task: "Synthetic task",
        watchForCompletion: false,
        modelSelection: { ...selection, effort: "xhigh" },
      }),
    );
    await waitFor(() => observed.length >= 2);
    await harness.drain();
    expect(observed).toEqual(["xhigh", "xhigh"]);
  } finally {
    setThreadToolModelSources(prior);
  }
});
