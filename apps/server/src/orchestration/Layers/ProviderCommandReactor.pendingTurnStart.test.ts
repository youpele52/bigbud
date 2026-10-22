import { DEFAULT_PROVIDER_INTERACTION_MODE } from "@bigbud/contracts/constants/runtime.constant.ts";
import { CommandId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  asMessageId,
  createHarness,
  registerProviderCommandReactorTestCleanup,
  waitFor,
} from "./ProviderCommandReactor.test.helpers.ts";
import { settleActiveTurn } from "./ProviderCommandReactor.test.settleTurn.ts";

const threadId = ThreadId.makeUnsafe("thread-1");

const turnStart = (id: string, provider?: "claudeAgent") => ({
  type: "thread.turn.start" as const,
  commandId: CommandId.makeUnsafe(`cmd-${id}`),
  threadId,
  message: { messageId: asMessageId(id), role: "user" as const, text: id, attachments: [] },
  ...(provider ? { modelSelection: { provider, model: "claude-opus-4-6" } } : {}),
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  runtimeMode: "approval-required" as const,
  createdAt: new Date().toISOString(),
});

const createdAt = new Date().toISOString();
const ready = (commandId: string) => ({
  type: "thread.session.set" as const,
  commandId: CommandId.makeUnsafe(commandId),
  threadId,
  session: {
    threadId,
    status: "ready" as const,
    providerName: "codex",
    runtimeMode: "approval-required" as const,
    activeTurnId: null,
    lastError: null,
    updatedAt: createdAt,
  },
  createdAt,
});

const gateOf = async (harness: Awaited<ReturnType<typeof createHarness>>) =>
  (await Effect.runPromise(harness.engine.getReadModel())).threads.find(
    (thread) => thread.id === threadId,
  )?.pendingTurnStart ?? null;

describe("ProviderCommandReactor pending turn starts", () => {
  registerProviderCommandReactorTestCleanup();

  it("re-drives a queued flush committed before it subscribed, exactly once", async () => {
    const harness = await createHarness({ startReactor: false });
    const dispatch = (command: Parameters<typeof harness.engine.dispatch>[0]) =>
      Effect.runPromise(harness.engine.dispatch(command));
    await dispatch(turnStart("first"));
    await dispatch(ready("cmd-ready"));
    await dispatch(turnStart("second"));
    // `first` fails while no reactor listens; once the session is ready again, the lifecycle
    // flush starts `second`.
    await dispatch({
      type: "thread.turn.start.failed",
      commandId: CommandId.makeUnsafe("cmd-first-failed"),
      threadId,
      context: "provider-turn-start",
      detail: "first failed",
      messageId: asMessageId("first"),
      createdAt,
    });
    await dispatch(ready("cmd-ready-again"));
    expect((await gateOf(harness))?.messageId).toBe("second");

    await harness.startReactor();
    await waitFor(async () => (await gateOf(harness)) === null);
    await harness.drain();
    // The server's flush is re-driven; the client's own `first` start is never resent.
    expect(harness.sendTurn.mock.calls).toHaveLength(1);
    const [sent] = harness.sendTurn.mock.calls[0]!;
    expect((sent as { input?: string }).input).toContain("second");
  });

  it("clears the gate when a start asks to switch the bound provider", async () => {
    const harness = await createHarness();
    await Effect.runPromise(harness.engine.dispatch(turnStart("first")));
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await settleActiveTurn(harness.engine, "cmd-settle-first", new Date().toISOString());

    await Effect.runPromise(harness.engine.dispatch(turnStart("switch", "claudeAgent")));
    await waitFor(async () => (await gateOf(harness)) === null);
    expect(harness.sendTurn.mock.calls).toHaveLength(1);
    const thread = (await Effect.runPromise(harness.engine.getReadModel())).threads.find(
      (entry) => entry.id === threadId,
    );
    expect(thread?.session?.status).toBe("error");
    expect(thread?.session?.lastError).toContain("cannot switch to 'claudeAgent'");
  });
});
