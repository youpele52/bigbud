/**
 * KilocodeAdapterLive — thin Effect Layer for KiloCode.
 *
 * KiloCode is a fork of OpenCode that uses the same SDK protocol and
 * `opencode serve`-compatible CLI (`kilo serve`).  This adapter
 * reuses the shared OpenCode session infrastructure with a different
 * provider constant and settings key.
 *
 * @module KilocodeAdapterLive
 */
import { type ProviderRuntimeEvent, ThreadId } from "@bigbud/contracts";
import { Effect, Layer, Queue, Stream } from "effect";

import { OpencodeServerManager } from "../../Services/Opencode/ServerManager.ts";
import { ServerConfig } from "../../../startup/config.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { makeEventNdjsonLogger } from "../EventNdjsonLogger.ts";
import { KilocodeAdapter, type KilocodeAdapterShape } from "../../Services/Kilocode/Adapter.ts";
import { makeSessionMethods, type SessionMethodDeps } from "../Opencode/Adapter.session.ts";
import { PROVIDER } from "./Adapter.types.ts";
import type { ActiveOpencodeSession } from "../Opencode/Adapter.types.ts";
import { makeNextEventId, makeEventStampFactory } from "../Opencode/Adapter.stream.ts";

export type { KilocodeAdapterLiveOptions } from "./Adapter.types.ts";

const makeKilocodeAdapter = Effect.fn("makeKilocodeAdapter")(function* (
  options?: import("./Adapter.types.ts").KilocodeAdapterLiveOptions,
) {
  const serverConfig = yield* ServerConfig;
  const serverSettings = yield* ServerSettingsService;
  const serverManager = yield* OpencodeServerManager;

  const services = yield* Effect.services<never>();

  const nativeEventLogger =
    options?.nativeEventLogger ??
    (options?.nativeEventLogPath !== undefined
      ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
      : undefined);

  const sessions = new Map<ThreadId, ActiveOpencodeSession>();
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

  const nextEventId = makeNextEventId();
  const makeEventStamp = makeEventStampFactory(nextEventId);

  const deps: SessionMethodDeps = {
    provider: PROVIDER,
    sessions,
    runtimeEventQueue,
    serverManager,
    serverSettings,
    serverConfig: { attachmentsDir: serverConfig.attachmentsDir },
    nextEventId,
    makeEventStamp,
    nativeEventLogger,
    services,
  };

  const sessionMethods = makeSessionMethods(deps);

  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "in-session",
    },
    ...sessionMethods,
    get streamEvents() {
      return Stream.fromQueue(runtimeEventQueue);
    },
  } satisfies KilocodeAdapterShape;
});

export const KilocodeAdapterLive = Layer.effect(KilocodeAdapter, makeKilocodeAdapter());

export function makeKilocodeAdapterLive(
  options?: import("./Adapter.types.ts").KilocodeAdapterLiveOptions,
) {
  return Layer.effect(KilocodeAdapter, makeKilocodeAdapter(options));
}
