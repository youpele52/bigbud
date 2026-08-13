import { Effect } from "effect";

import { CodexAppServerManager } from "../../../codex/codexAppServerManager.ts";
import { makeEventNdjsonLogger } from "../EventNdjsonLogger.ts";
import type { CodexAdapterLiveOptions } from "./Adapter.types.ts";

export const acquireCodexManager = Effect.fn("acquireCodexManager")(function* (
  options?: CodexAdapterLiveOptions,
) {
  if (options?.manager) return options.manager;
  const services = yield* Effect.services<never>();
  return options?.makeManager?.(services) ?? new CodexAppServerManager(services);
});

export function resolveCodexNativeEventLogger(options?: CodexAdapterLiveOptions) {
  if (options?.nativeEventLogger) return Effect.succeed(options.nativeEventLogger);
  return options?.nativeEventLogPath
    ? makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
    : Effect.sync((): undefined => undefined);
}
