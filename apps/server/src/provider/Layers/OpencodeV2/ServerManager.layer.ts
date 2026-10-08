import { Effect, Layer } from "effect";

import { OpencodeV2ServerManager as Service } from "../../Services/OpencodeV2/ServerManager.ts";
import { OpencodeV2ServerManager } from "./ServerManager.ts";

/** Explicit caller-supplied development bounds are not approved preview/load budgets. */
export function makeOpencodeV2ServerManagerLive(bounds: {
  readonly maxProcesses: number;
  readonly maxOwners: number;
  readonly maxQueuedEvents: number;
  readonly maxEventBytes: number;
  readonly consumerTimeoutMs: number;
}) {
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      const manager = new OpencodeV2ServerManager(bounds);
      yield* Effect.addFinalizer(() => Effect.promise(() => manager.close()));
      return manager;
    }),
  );
}
