import { assert, it } from "@effect/vitest";
import { Effect, Ref } from "effect";

import { persistThreadRetentionPolicy } from "./ThreadRetention.policy.ts";

it.effect("does not write authority when settings persistence fails", () =>
  Effect.gen(function* () {
    const authorityWrites = yield* Ref.make(0);
    const exit = yield* Effect.exit(
      persistThreadRetentionPolicy({
        policy: "7-days",
        previousPolicy: "never",
        setSettings: () => Effect.fail("settings-failed"),
        setAuthority: () => Ref.update(authorityWrites, (count) => count + 1),
      }),
    );
    assert.equal(exit._tag, "Failure");
    assert.equal(yield* Ref.get(authorityWrites), 0);
  }),
);

it.effect("rolls settings back when authority persistence fails", () =>
  Effect.gen(function* () {
    const settingsWrites = yield* Ref.make<ReadonlyArray<string>>([]);
    const exit = yield* Effect.exit(
      persistThreadRetentionPolicy({
        policy: "30-days",
        previousPolicy: "never",
        setSettings: (policy) =>
          Ref.update(settingsWrites, (writes) => [...writes, policy]).pipe(Effect.as(policy)),
        setAuthority: () => Effect.fail("authority-failed"),
      }),
    );
    assert.equal(exit._tag, "Failure");
    assert.deepEqual(yield* Ref.get(settingsWrites), ["30-days", "never"]);
  }),
);

it.effect("surfaces a rollback failure instead of ignoring it", () =>
  Effect.gen(function* () {
    let writeCount = 0;
    const exit = yield* Effect.exit(
      persistThreadRetentionPolicy({
        policy: "30-days",
        previousPolicy: "never",
        setSettings: (policy) => {
          writeCount += 1;
          return writeCount === 1 ? Effect.succeed(policy) : Effect.fail("rollback-failed");
        },
        setAuthority: () => Effect.fail("authority-failed"),
      }),
    );
    assert.equal(exit._tag, "Failure");
    if (exit._tag === "Failure") assert.include(String(exit.cause), "rollback-failed");
  }),
);
