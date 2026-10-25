import {
  type ChatAttachment,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ThreadId,
} from "@bigbud/contracts";
import { Effect } from "effect";

import { ProviderAdapterSessionClosedError } from "../../provider/Errors.ts";
import {
  asMessageId,
  asTurnId,
  type createHarness,
  waitFor,
} from "./ProviderCommandReactor.test.helpers.ts";
import { settleActiveTurn } from "./ProviderCommandReactor.test.settleTurn.ts";

export type Harness = Awaited<ReturnType<typeof createHarness>>;
export const THREAD = ThreadId.makeUnsafe("thread-1");
/** The adapter proves the session was dead before dispatch, so recovery may resend. */
export const sessionDead = () =>
  Effect.fail(
    new ProviderAdapterSessionClosedError({
      provider: "codex",
      threadId: THREAD,
      failureClass: "session-dead",
    }),
  );

export async function completeFirstTurn(harness: Harness) {
  await dispatchTurn(harness, "first", "first question");
  await waitFor(() => harness.sendTurn.mock.calls.length === 1);
  await Effect.runPromise(
    harness.engine.dispatch({
      type: "thread.message.assistant.delta",
      commandId: CommandId.makeUnsafe("cmd-assistant-first-delta"),
      threadId: THREAD,
      messageId: asMessageId("assistant-first"),
      turnId: asTurnId("turn-1"),
      delta: "first answer",
      createdAt: new Date(Date.now() + 400).toISOString(),
    }),
  );
  await Effect.runPromise(
    harness.engine.dispatch({
      type: "thread.message.assistant.complete",
      commandId: CommandId.makeUnsafe("cmd-assistant-first"),
      threadId: THREAD,
      messageId: asMessageId("assistant-first"),
      turnId: asTurnId("turn-1"),
      createdAt: new Date(Date.now() + 500).toISOString(),
    }),
  );
  await settleActiveTurn(
    harness.engine,
    "cmd-first-settled",
    new Date(Date.now() + 600).toISOString(),
  );
}

export function dispatchTurn(
  harness: Harness,
  id: string,
  text: string,
  attachments: ReadonlyArray<ChatAttachment> = [],
) {
  return Effect.runPromise(
    harness.engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.makeUnsafe(`cmd-turn-${id}`),
      threadId: THREAD,
      message: { messageId: asMessageId(`user-${id}`), role: "user", text, attachments },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: new Date(Date.now() + 1000).toISOString(),
    }),
  );
}

export const activities = async (harness: Harness) =>
  (await Effect.runPromise(harness.engine.getReadModel())).threads.find(
    (thread) => thread.id === THREAD,
  )?.activities ?? [];
export const failures = async (harness: Harness) =>
  (await activities(harness)).filter((entry) => entry.kind === "provider.turn.start.failed");
export const recoveries = async (harness: Harness) =>
  (await activities(harness))
    .filter((entry) => entry.kind === "provider.session.recovery")
    .map((entry) => entry.payload as { step: string; outcome: string });
/** Provider sends for the source thread; an automatic fork (D18) sends on its own thread. */
export const sourceSends = (harness: Harness) =>
  harness.sendTurn.mock.calls.filter(
    (call) => (call[0] as { threadId?: unknown } | undefined)?.threadId === THREAD,
  );
export const sendInput = (harness: Harness, index: number) =>
  (harness.sendTurn.mock.calls[index]?.[0] as { input?: string } | undefined)?.input ?? "";
export const startInput = (harness: Harness, index: number) =>
  harness.startSession.mock.calls[index]?.[1] as { resumeCursor?: unknown } | undefined;
/** Waits until the turn either reached `sends` provider sends or recorded a failure. */
export async function settle(harness: Harness, sends: number) {
  await waitFor(
    async () => harness.sendTurn.mock.calls.length >= sends || (await failures(harness)).length > 0,
  );
  await new Promise((resolve) => setTimeout(resolve, 200)); // Prove no further (looping) attempt.
}
