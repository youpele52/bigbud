/**
 * OpencodeAdapterLive — thin Effect Layer shell.
 *
 * Wires service dependencies and delegates all business logic to the
 * focused sub-modules:
 *  - `OpencodeAdapter.types`   — types, interfaces, constants
 *  - `OpencodeAdapter.stream`  — SSE event mapping and stream management
 *  - `OpencodeAdapter.session` — session lifecycle methods
 *
 * @module OpencodeAdapterLive
 */
import { type ProviderRuntimeEvent, ThreadId } from "@bigbud/contracts";
import { Effect, Layer, Queue, Stream } from "effect";

import { OpencodeServerManager } from "../../Services/Opencode/ServerManager.ts";
import { ServerConfig } from "../../../startup/config.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { makeEventNdjsonLogger } from "../EventNdjsonLogger.ts";
import { OpencodeAdapter, type OpencodeAdapterShape } from "../../Services/Opencode/Adapter.ts";
import { PROVIDER, type ActiveOpencodeSession } from "./Adapter.types.ts";
import { makeNextEventId, makeEventStampFactory } from "./Adapter.stream.ts";
import { makeSessionMethods, type SessionMethodDeps } from "./Adapter.session.ts";

export type { OpencodeAdapterLiveOptions } from "./Adapter.types.ts";

const makeOpencodeAdapter = Effect.fn("makeOpencodeAdapter")(function* (
  options?: import("./Adapter.types.ts").OpencodeAdapterLiveOptions,
) {
  const serverConfig = yield* ServerConfig;
  const serverSettings = yield* ServerSettingsService;
  const serverManager = yield* OpencodeServerManager;

  // Capture the Effect services context so we can run effects from
  // non-Effect code (e.g. the SSE event loop).
  const services = yield* Effect.services<never>();

  const nativeEventLogger =
    options?.nativeEventLogger ??
    (options?.nativeEventLogPath !== undefined
      ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
          stream: "native",
        })
      : undefined);

  const sessions = new Map<ThreadId, ActiveOpencodeSession>();
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

  const nextEventId = makeNextEventId();
  const makeEventStamp = makeEventStampFactory(nextEventId);

  const deps: SessionMethodDeps = {
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
  } satisfies OpencodeAdapterShape;
});

export const OpencodeAdapterLive = Layer.effect(OpencodeAdapter, makeOpencodeAdapter());

export function makeOpencodeAdapterLive(
  options?: import("./Adapter.types.ts").OpencodeAdapterLiveOptions,
) {
  return Layer.effect(OpencodeAdapter, makeOpencodeAdapter(options));
}
