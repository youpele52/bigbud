import { readFileSync } from "node:fs";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderRuntimeEvent } from "@bigbud/contracts";
import { Effect, Fiber, Stream } from "effect";

import { ClaudeAdapter } from "../../Services/Claude/Adapter.ts";
import type { ClaudeInitializationResult } from "./Adapter.sdk.ts";
import { THREAD_ID, type makeHarness } from "./Adapter.test.helpers.ts";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/sdk-0.3.301-subagent-messages.json", import.meta.url), "utf8"),
) as { readonly agents: unknown; readonly messages: unknown };

export const SUBAGENT_FIXTURE_MESSAGES = fixture.messages as unknown as ReadonlyArray<SDKMessage>;

export type TaskUpdate = Extract<ProviderRuntimeEvent, { type: "task.updated" }>["payload"];

/** Latest `task.updated` payload per native task ID. */
export function latestTaskUpdates(
  events: ReadonlyArray<ProviderRuntimeEvent>,
): Map<string, TaskUpdate> {
  const latest = new Map<string, TaskUpdate>();
  for (const event of events) {
    if (event.type === "task.updated") latest.set(event.payload.nativeId ?? "", event.payload);
  }
  return latest;
}

export const fixtureInitialization = () =>
  ({
    commands: [],
    agents: fixture.agents,
    output_style: "default",
    available_output_styles: [],
    models: [],
    account: {},
  }) as unknown as ClaudeInitializationResult;

/**
 * Starts a session and a turn, emits `messages`, and collects runtime events until `until`
 * matches (or the stream yields `limit` events).
 */
export const replayClaudeMessages = Effect.fn("replayClaudeMessages")(function* (
  harness: ReturnType<typeof makeHarness>,
  messages: ReadonlyArray<SDKMessage>,
  until: (event: ProviderRuntimeEvent) => boolean,
) {
  const adapter = yield* ClaudeAdapter;
  const eventsFiber = yield* adapter.streamEvents.pipe(
    Stream.takeUntil(until),
    Stream.runCollect,
    Effect.forkChild,
  );
  yield* adapter.startSession({
    threadId: THREAD_ID,
    provider: "claudeAgent",
    runtimeMode: "full-access",
  });
  yield* adapter.sendTurn({ threadId: THREAD_ID, input: "delegate", attachments: [] });
  // Let the best-effort initializationResult() read settle before frames arrive.
  yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)));
  for (const message of messages) harness.query.emit(message);
  const events = Array.from(yield* Fiber.join(eventsFiber));
  yield* adapter.stopSession(THREAD_ID);
  return events;
});

export const isTaskDone = (nativeId: string) => (event: ProviderRuntimeEvent) =>
  event.type === "task.updated" &&
  event.payload.nativeId === nativeId &&
  event.payload.status === "completed";
