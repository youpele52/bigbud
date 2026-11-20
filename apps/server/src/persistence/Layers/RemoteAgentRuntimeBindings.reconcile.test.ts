import { it, expect } from "@effect/vitest";
import { Effect } from "effect";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { RemoteAgentRuntimeOwnersLive } from "./RemoteAgentRuntimeBindings.ts";
import { RemoteAgentRuntimeOwners } from "./RemoteAgentRuntimeBindings.service.ts";
import { profileOwner } from "../../remote-agent/remoteAgentOwnedPty.profile.testUtils.ts";

it.layer(SqlitePersistenceMemory)("target-scoped runtime reconciliation", (it) => {
  it.effect("retains other SSH/local owners even with identical generation and epoch", () =>
    Effect.gen(function* () {
      const owners = yield* RemoteAgentRuntimeOwners;
      const shared = profileOwner();
      const first = { ...shared, ownerKey: "terminal:ssh-first" };
      const second = { ...shared, ownerKey: "terminal:ssh-second", target: "ssh:another-host" };
      const local = {
        ...shared,
        ownerKey: "terminal:local",
        target: `remote-backend:${"a".repeat(32)}`,
      };
      const terminal = {
        ...shared,
        ownerKey: "terminal:already-exited",
        state: "terminal" as const,
      };
      for (const owner of [first, second, local, terminal])
        yield* Effect.promise(() => owners.reserve(owner));
      yield* Effect.promise(() =>
        owners.reconcileRuntime!(first.target, first.runtime.generation, first.epoch),
      );
      expect(yield* Effect.promise(() => owners.get(first.ownerKey))).toMatchObject({
        state: "outcome-unknown",
        interruptionReason: "restart",
      });
      for (const owner of [second, local, terminal])
        expect(yield* Effect.promise(() => owners.get(owner.ownerKey))).toEqual(owner);
      yield* Effect.promise(() =>
        owners.reconcileRuntime!(local.target, local.runtime.generation, local.epoch),
      );
      expect(yield* Effect.promise(() => owners.get(local.ownerKey))).toMatchObject({
        state: "outcome-unknown",
        interruptionReason: "restart",
      });
      expect(yield* Effect.promise(() => owners.get(second.ownerKey))).toEqual(second);
    }).pipe(Effect.provide(RemoteAgentRuntimeOwnersLive)),
  );
});
