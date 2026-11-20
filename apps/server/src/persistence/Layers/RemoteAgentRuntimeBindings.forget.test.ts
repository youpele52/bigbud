import { vi } from "vitest";
vi.mock("../../remote-agent/remoteAgentInstall.maintenance.ts", async () => {
  const { Effect } = await import("effect");
  return { makeRemoteAgentMaintenance: Effect.succeed({ schedule: vi.fn() }) };
});
import { it, expect } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import {
  RemoteAgentRuntimeBindingsLive,
  RemoteAgentRuntimeOwnersLive,
} from "./RemoteAgentRuntimeBindings.ts";
import { remoteAgentOwners } from "../../remote-agent/remoteAgentOwners.ts";
import { profileOwner } from "../../remote-agent/remoteAgentOwnedPty.profile.testUtils.ts";

it.layer(SqlitePersistenceMemory)("forgetting a removed agent target", (it) => {
  it.effect("drops the selected connection and bindings no live owner still names", () =>
    Effect.gen(function* () {
      yield* Layer.build(
        RemoteAgentRuntimeBindingsLive.pipe(Layer.provideMerge(RemoteAgentRuntimeOwnersLive)),
      );
      const store = remoteAgentOwners();
      const owner = profileOwner();
      const binding = { runtime: owner.runtime, expectedEpoch: owner.epoch };
      yield* Effect.promise(() => store.bindConnection(owner.target, owner.connectionId, binding));
      yield* Effect.promise(() => store.bindConnection(owner.target, "stale-connection", binding));
      // A possibly-live terminal still names the first connection.
      yield* Effect.promise(() => store.reserve(owner));
      yield* Effect.promise(() => store.forgetTarget!(owner.target));
      expect(yield* Effect.promise(() => store.getBinding(owner.target))).toBeUndefined();
      expect(yield* Effect.promise(() => store.listConnectionIds!(owner.target))).toEqual([
        owner.connectionId,
      ]);
      expect(yield* Effect.promise(() => store.get(owner.ownerKey))).toBeDefined();
    }),
  );

  it.effect("still clears stale bindings when an owner row has no connection id", () =>
    Effect.gen(function* () {
      yield* Layer.build(
        RemoteAgentRuntimeBindingsLive.pipe(Layer.provideMerge(RemoteAgentRuntimeOwnersLive)),
      );
      const sql = yield* SqlClient.SqlClient;
      const store = remoteAgentOwners();
      const owner = profileOwner();
      const target = `${owner.target}-null`;
      const binding = { runtime: owner.runtime, expectedEpoch: owner.epoch };
      yield* Effect.promise(() => store.bindConnection(target, "stale-connection", binding));
      // A malformed, non-terminal row whose connection id reads as NULL must not stop cleanup.
      const route = JSON.stringify({ target, state: "outcome-unknown" });
      yield* sql`INSERT INTO remote_agent_runtime_owners (owner_key, route_json) VALUES ('terminal:null-row', ${route})`;
      yield* Effect.promise(() => store.forgetTarget!(target));
      expect(yield* Effect.promise(() => store.listConnectionIds!(target))).toEqual([]);
    }),
  );
});
