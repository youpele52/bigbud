import { vi } from "vitest";
const { schedule } = vi.hoisted(() => ({ schedule: vi.fn() }));
vi.mock("../../remote-agent/remoteAgentInstall.maintenance.ts", async () => {
  const { Effect } = await import("effect");
  return { makeRemoteAgentMaintenance: Effect.succeed({ schedule }) };
});
import { it, expect } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import {
  RemoteAgentRuntimeBindingsLive,
  RemoteAgentRuntimeOwnersLive,
} from "./RemoteAgentRuntimeBindings.ts";
import { RemoteAgentRuntimeOwners } from "./RemoteAgentRuntimeBindings.service.ts";
import {
  remoteAgentOwners,
  type RemoteAgentOwnerStore,
} from "../../remote-agent/remoteAgentOwners.ts";
import { profileOwner } from "../../remote-agent/remoteAgentOwnedPty.profile.testUtils.ts";

it.layer(SqlitePersistenceMemory)("shared durable Rust owner service", (it) => {
  it.effect(
    "gives SSH initialization and scoped local consumers the same CAS store and SqlClient",
    () =>
      Effect.gen(function* () {
        const seen: RemoteAgentOwnerStore[] = [];
        const consumer = () =>
          Layer.effectDiscard(
            Effect.gen(function* () {
              seen.push(yield* RemoteAgentRuntimeOwners);
            }),
          );
        yield* Layer.build(
          Layer.mergeAll(RemoteAgentRuntimeBindingsLive, consumer(), consumer()).pipe(
            Layer.provideMerge(RemoteAgentRuntimeOwnersLive),
          ),
        );
        expect(seen).toHaveLength(2);
        expect(seen[0]).toBe(seen[1]);
        expect(seen[0]).toBe(remoteAgentOwners());
        const owner = profileOwner();
        yield* Effect.promise(() =>
          seen[0]!.bindConnection(owner.target, "shared-binding", {
            runtime: owner.runtime,
            expectedEpoch: owner.epoch,
          }),
        );
        const localTarget = `remote-backend:${"a".repeat(32)}`;
        yield* Effect.promise(() =>
          seen[0]!.bindConnection(localTarget, "local-binding", {
            runtime: owner.runtime,
            expectedEpoch: owner.epoch,
          }),
        );
        schedule.mockClear();
        // A new backend scope must run initialization again, rather than reuse this test scope memo.
        yield* Layer.build(Layer.fresh(RemoteAgentRuntimeBindingsLive));
        expect(schedule).toHaveBeenCalledExactlyOnceWith(owner.target);
        expect(schedule).not.toHaveBeenCalledWith(localTarget);
        expect(yield* Effect.promise(() => seen[1]!.getBinding(localTarget))).toMatchObject({
          connectionId: "local-binding",
        });
        expect(yield* Effect.promise(() => seen[1]!.getBinding(owner.target))).toMatchObject({
          runtime: owner.runtime,
          expectedEpoch: owner.epoch,
          connectionId: "shared-binding",
        });
      }),
  );
});
