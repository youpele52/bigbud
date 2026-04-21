/**
 * PiAdapterLive — thin Effect Layer shell.
 *
 * Wires Effect services and delegates Pi session lifecycle and RPC stream
 * mapping to the focused split modules.
 *
 * @module PiAdapterLive
 */
import { EventId, ThreadId, TurnId, type ProviderRuntimeEvent } from "@bigbud/contracts";
import { Effect, Layer, Queue, Random, Stream } from "effect";

import { ServerConfig } from "../../startup/config.ts";
import { ServerSettingsService } from "../../ws/serverSettings.ts";
import { PiAdapter, type PiAdapterShape } from "../Services/PiAdapter.ts";
import { makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { makePiAdapterMethods } from "./PiAdapter.methods.ts";
import { makeHandleProcessExit, makeHandleStdoutEvent } from "./PiAdapter.stream.ts";
import {
  type ActivePiSession,
  PROVIDER,
  type PiAdapterLiveOptions,
  type PiSyntheticEventFn,
} from "./PiAdapter.types.ts";
import { eventBase } from "./PiAdapter.utils.ts";

export type { PiAdapterLiveOptions } from "./PiAdapter.types.ts";

export const makePiAdapter = Effect.fn("makePiAdapter")(function* (options?: PiAdapterLiveOptions) {
  const serverConfig = yield* ServerConfig;
  const serverSettings = yield* ServerSettingsService;
  const services = yield* Effect.services<never>();
  const runPromise = Effect.runPromiseWith(services);

  const nativeEventLogger =
    options?.nativeEventLogger ??
    (options?.nativeEventLogPath !== undefined
      ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
          stream: "native",
        })
      : undefined);

  const sessions = new Map<ThreadId, ActivePiSession>();
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const nextEventId = Effect.map(Random.nextUUIDv4, (id) => EventId.makeUnsafe(id));

  const makeEventStamp = () =>
    Effect.all({
      eventId: nextEventId,
      createdAt: Effect.sync(() => new Date().toISOString()),
    });

  const emit = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
    Queue.offerAll(runtimeEventQueue, events).pipe(Effect.asVoid);

  const writeNativeEvent = Effect.fn("writeNativeEvent")(function* (
    threadId: ThreadId,
    event: unknown,
  ) {
    if (!nativeEventLogger) {
      return;
    }

    yield* nativeEventLogger.write(
      {
        observedAt: new Date().toISOString(),
        event,
      },
      threadId,
    );
  });

  const makeSyntheticEvent = (<TType extends ProviderRuntimeEvent["type"]>(
    threadId: ThreadId,
    type: TType,
    payload: Extract<ProviderRuntimeEvent, { type: TType }>["payload"],
    extra?: { turnId?: TurnId; itemId?: string; requestId?: string },
  ): Effect.Effect<Extract<ProviderRuntimeEvent, { type: TType }>> =>
    Effect.gen(function* () {
      const stamp = yield* makeEventStamp();
      return {
        ...eventBase({
          eventId: stamp.eventId,
          createdAt: stamp.createdAt,
          threadId,
          ...(extra?.turnId ? { turnId: extra.turnId } : {}),
          ...(extra?.itemId ? { itemId: extra.itemId } : {}),
          ...(extra?.requestId ? { requestId: extra.requestId } : {}),
          raw: {
            source: "pi.rpc.synthetic",
            payload,
          },
        }),
        type,
        payload,
      } as Extract<ProviderRuntimeEvent, { type: TType }>;
    })) as PiSyntheticEventFn;

  const handleProcessExit = makeHandleProcessExit({
    emit,
    makeSyntheticEvent,
    sessions,
  });
  const handleStdoutEvent = makeHandleStdoutEvent({
    emit,
    makeEventStamp,
    makeSyntheticEvent,
    runPromise,
    sessions,
    writeNativeEvent,
  });

  const methods = makePiAdapterMethods({
    attachmentsDir: serverConfig.attachmentsDir,
    emit,
    handleProcessExit,
    handleStdoutEvent,
    makeSyntheticEvent,
    runPromise,
    serverSettings,
    sessions,
  });

  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "in-session",
    },
    ...methods,
    get streamEvents() {
      return Stream.fromQueue(runtimeEventQueue);
    },
  } satisfies PiAdapterShape;
});

export const PiAdapterLive = Layer.effect(PiAdapter, makePiAdapter());

export function makePiAdapterLive(options?: PiAdapterLiveOptions) {
  return Layer.effect(PiAdapter, makePiAdapter(options));
}
