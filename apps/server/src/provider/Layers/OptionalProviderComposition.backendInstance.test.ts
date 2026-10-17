import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, Logger } from "effect";
import { describe, expect, it } from "vitest";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { StateDirLockLive } from "../../startup/backendInstance.ts";
import { ServerConfig } from "../../startup/config.ts";
import { ServerSettingsService } from "../../ws/serverSettings.ts";
import { OptionalProviderRegistrations } from "../ProviderRegistration.ts";
import { OptionalProviderCompositionLive } from "./OptionalProviderComposition.ts";
import { ThreadToolsActivationLive } from "./OpencodeV2/ThreadToolsActivation.ts";

/**
 * Mirrors `makeServerLayer`: the backend lock is provided around the whole runtime, and the
 * provider infrastructure provides `OptionalProviderCompositionLive` to itself. The V2
 * registration must still see `BackendInstance`, or dead-backend recovery is off in production.
 */
async function composedRecoveryLog(withLock: boolean): Promise<unknown[]> {
  const messages: unknown[] = [];
  const consumer = Layer.effectDiscard(
    Effect.gen(function* () {
      yield* OptionalProviderRegistrations;
    }),
  ).pipe(Layer.provide(OptionalProviderCompositionLive));
  const runtime = consumer.pipe(
    Layer.provideMerge(ThreadToolsActivationLive),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(SqlitePersistenceMemory),
  );
  const server = (withLock ? runtime.pipe(Layer.provide(StateDirLockLive)) : runtime).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "bigbud-backend-wiring-" })),
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(
      Logger.layer([Logger.make(({ message }) => void messages.push(message))], {
        mergeWithExisting: false,
      }),
    ),
  );
  await Effect.runPromise(Effect.scoped(Layer.build(server)));
  return messages.flat().filter((message) => JSON.stringify(message).includes("dead-backend"));
}

describe("OpenCode V2 dead-backend recovery wiring", () => {
  it("sees the backend instance through the server composition and logs it once", async () => {
    const enabled = await composedRecoveryLog(true);
    expect(enabled).toHaveLength(1);
    expect(JSON.stringify(enabled[0])).toContain("enabled");
    expect(JSON.stringify(enabled)).not.toMatch(/nonce|lockPath|pid/i);
  });

  it("reports recovery disabled when no backend instance is composed", async () => {
    const disabled = await composedRecoveryLog(false);
    expect(disabled).toHaveLength(1);
    expect(JSON.stringify(disabled[0])).toContain("disabled");
  });
});
