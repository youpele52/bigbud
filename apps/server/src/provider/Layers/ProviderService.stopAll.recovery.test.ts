import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";

import { PersistenceSqlError } from "../../persistence/Errors.ts";
import type { ThreadRecoveryIntentRepositoryShape } from "../../persistence/Services/ThreadRecoveryIntents.ts";
import type { ProviderSessionDirectoryShape } from "../Services/ProviderSessionDirectory.ts";
import { makeRunStopAll } from "./ProviderService.operations.ts";
import { suspendRecoveryIntentsForStopAll } from "./ProviderService.stopAll.ts";

type RunStopAllArgs = Parameters<typeof makeRunStopAll>;

describe("provider stop-all and recovery intents", () => {
  it.effect("suspends intents with the app-exit reason before stopping adapters", () =>
    Effect.gen(function* () {
      const timeline: string[] = [];
      const adapter = {
        provider: "codex",
        listSessions: () => Effect.succeed([]),
        stopAll: () => Effect.sync(() => timeline.push("adapter:stop")),
      };
      const directory = {
        listThreadIds: () => Effect.succeed([ThreadId.makeUnsafe("t")]),
        getProvider: () => Effect.succeed("codex"),
        upsert: () => Effect.void,
      } as unknown as ProviderSessionDirectoryShape;
      yield* makeRunStopAll(
        [adapter] as unknown as RunStopAllArgs[0],
        directory,
        () => Effect.void,
        { record: () => Effect.void, flush: Effect.void } as unknown as RunStopAllArgs[3],
        {
          suspendRecoveryIntents: (reason) => Effect.sync(() => timeline.push(`suspend:${reason}`)),
        },
      );
      assert.deepStrictEqual(timeline, ["suspend:app-exit", "adapter:stop"]);
    }),
  );

  it.effect("suspends, never revokes, and never fails the shutdown", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const repository = {
        suspendActiveForExit: () =>
          Effect.sync(() => calls.push("suspendActiveForExit")).pipe(Effect.as(2)),
        revokeForThread: () => Effect.sync(() => calls.push("revokeForThread")),
      } as unknown as ThreadRecoveryIntentRepositoryShape;
      yield* suspendRecoveryIntentsForStopAll(Option.some(repository), "app-exit");
      assert.deepStrictEqual(calls, ["suspendActiveForExit"]);
      const failing = {
        suspendActiveForExit: () =>
          Effect.fail(new PersistenceSqlError({ operation: "test", detail: "closed" })),
      } as unknown as ThreadRecoveryIntentRepositoryShape;
      yield* suspendRecoveryIntentsForStopAll(Option.some(failing), "app-exit");
    }),
  );
});
