import type {
  OrchestrationReadModel,
  ProviderRuntimeEvent,
  ProviderSession,
} from "@bigbud/contracts";
import { EventId, ProjectId, ThreadId, TurnId } from "@bigbud/contracts";
import { Effect, PubSub, Stream } from "effect";

import type { OrchestrationEngineShape } from "../../../orchestration/Services/OrchestrationEngine.ts";
import type { ProviderServiceShape } from "../../Services/ProviderService.ts";

export const asEventId = (value: string): EventId => EventId.makeUnsafe(value);
export const asProjectId = (value: string): ProjectId => ProjectId.makeUnsafe(value);
export const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);
export const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);

export function createProviderServiceHarness() {
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
  const emittedEvents: ProviderRuntimeEvent[] = [];
  const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;

  const service: ProviderServiceShape = {
    startSession: () => unsupported(),
    startSessionFresh: () => unsupported(),
    sendTurn: () => unsupported(),
    interruptTurn: () => unsupported(),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    stopSession: () => unsupported(),
    listSessions: () => Effect.succeed([] as ProviderSession[]),
    getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
    rollbackConversation: () => unsupported(),
    get streamEvents() {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  };

  const publish = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
    Effect.sync(() => {
      emittedEvents.push(...events);
    }).pipe(Effect.andThen(PubSub.publishAll(runtimeEventPubSub, events)), Effect.asVoid);

  return {
    emittedEvents,
    publish,
    service,
  };
}

export async function waitForThread(
  engine: OrchestrationEngineShape,
  predicate: (thread: PiRuntimeTestThread) => boolean,
  timeoutMs = 2_000,
) {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<PiRuntimeTestThread> => {
    const readModel = await Effect.runPromise(engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === asThreadId("thread-1"));
    if (thread && predicate(thread)) {
      return thread;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for projected Pi thread state.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return poll();
  };
  return poll();
}

export type PiRuntimeTestThread = OrchestrationReadModel["threads"][number];
export type PiRuntimeTestMessage = PiRuntimeTestThread["messages"][number];
