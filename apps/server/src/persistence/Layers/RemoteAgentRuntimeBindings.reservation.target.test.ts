import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Statement from "effect/unstable/sql/Statement";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { makeRemoteAgentRuntimeBindings } from "./RemoteAgentRuntimeBindings.ts";
import { MAX_REMOTE_AGENT_TERMINAL_OWNERS } from "../../remote-agent/remoteAgentInstall.registry.ts";
import { makeLocalSupervisorAuthorityOwners } from "../../remote-backend/localSupervisorOwners.ts";
import { remoteAgentReplayFence } from "./RemoteAgentRuntimeBindings.replay.ts";
import { profileOwner } from "../../remote-agent/remoteAgentOwnedPty.profile.testUtils.ts";

const localTarget = `remote-backend:${"a".repeat(32)}`;
it.layer(SqlitePersistenceMemory)("atomic target-scoped owner reservation", (it) => {
  it.effect("cannot replace a foreign terminal owner with a colliding pane key", () =>
    Effect.gen(function* () {
      const owners = yield* makeRemoteAgentRuntimeBindings;
      const foreign = {
        ...profileOwner(),
        ownerKey: "terminal:collision",
        state: "terminal" as const,
      };
      yield* Effect.promise(() => owners.reserve(foreign));
      yield* Effect.promise(() =>
        expect(
          owners.reserve(
            { ...foreign, target: localTarget, resourceId: "new-resource", state: "prepared" },
            true,
            localTarget,
          ),
        ).rejects.toThrow("another target"),
      );
      expect(yield* Effect.promise(() => owners.get(foreign.ownerKey))).toEqual(foreign);
    }),
  );
  it.effect(
    "does not delete a foreign prepared owner with a colliding resource, while preserving legacy rollback",
    () =>
      Effect.gen(function* () {
        const owners = yield* makeRemoteAgentRuntimeBindings;
        const foreign = {
          ...profileOwner(),
          ownerKey: "terminal:rollback",
          state: "prepared" as const,
        };
        yield* Effect.promise(() => owners.reserve(foreign));
        expect(
          yield* Effect.promise(() =>
            owners.rollbackPrepared!(foreign.ownerKey, foreign.resourceId, localTarget),
          ),
        ).toBe(false);
        expect(yield* Effect.promise(() => owners.get(foreign.ownerKey))).toEqual(foreign);
        expect(
          yield* Effect.promise(() =>
            owners.rollbackPrepared!(foreign.ownerKey, foreign.resourceId),
          ),
        ).toBe(true);
      }),
  );
  it.effect(
    "atomic target predicate defeats a stale target observation before terminal replacement",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        let armed = false;
        let observedStale = false;
        const transformer: Statement.Transformer = (statement) => {
          const [query] = statement.compile();
          if (
            !armed ||
            observedStale ||
            !query.includes("SELECT route_json FROM remote_agent_runtime_owners")
          )
            return Effect.succeed(statement);
          observedStale = true;
          // The actual current row remains foreign. Only the earlier SELECT observes a stale local row.
          return Effect.succeed(
            sql`SELECT json_set(route_json, '$.target', ${localTarget}) AS route_json FROM remote_agent_runtime_owners WHERE owner_key = 'terminal:stale'`,
          );
        };
        const owners = yield* makeRemoteAgentRuntimeBindings.pipe(
          Effect.provideService(Statement.CurrentTransformer, transformer),
        );
        const foreign = {
          ...profileOwner(),
          ownerKey: "terminal:stale",
          invocationId: "previous-invocation",
          state: "terminal" as const,
        };
        yield* Effect.promise(() => owners.reserve(foreign));
        const before =
          yield* sql`SELECT route_json, revision FROM remote_agent_runtime_owners WHERE owner_key = ${foreign.ownerKey}`;
        const fencesBefore =
          yield* sql`SELECT slot, bits FROM remote_agent_replay_fence ORDER BY slot`;
        armed = true;
        yield* Effect.promise(() =>
          expect(
            owners.reserve(
              {
                ...foreign,
                target: localTarget,
                resourceId: "new-resource",
                state: "prepared",
                invocationId: "next-invocation",
              },
              true,
              localTarget,
            ),
          ).rejects.toThrow("another target"),
        );
        expect(observedStale).toBe(true);
        expect(yield* sql`SELECT slot, bits FROM remote_agent_replay_fence ORDER BY slot`).toEqual(
          fencesBefore,
        );
        expect(
          yield* sql`SELECT route_json, revision FROM remote_agent_runtime_owners WHERE owner_key = ${foreign.ownerKey}`,
        ).toEqual(before);
      }),
  );
  it.effect("local terminal completion prunes only its own target and replay history", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const owners = yield* makeRemoteAgentRuntimeBindings;
      const foreign = {
        ...profileOwner(),
        ownerKey: "terminal:prune-foreign",
        state: "terminal" as const,
      };
      yield* Effect.promise(() => owners.reserve(foreign));
      for (let index = 0; index < MAX_REMOTE_AGENT_TERMINAL_OWNERS + 1; index++) {
        const row = { ...foreign, target: localTarget, ownerKey: `terminal:prune-local-${index}` };
        yield* sql`INSERT INTO remote_agent_runtime_owners (owner_key, route_json) VALUES (${row.ownerKey}, ${JSON.stringify(row)})`;
      }
      const local = makeLocalSupervisorAuthorityOwners({
        owners,
        targetId: localTarget,
        assertAuthority: async () => {},
      });
      yield* Effect.promise(() => local.update("terminal:prune-local-256", (owner) => owner));
      expect(yield* Effect.promise(() => owners.get(foreign.ownerKey))).toEqual(foreign);
      yield* remoteAgentReplayFence(sql).assertNew(foreign.ownerKey);
      expect(yield* Effect.promise(() => owners.get("terminal:prune-local-0"))).toBeUndefined();
      const retained = yield* sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM remote_agent_runtime_owners WHERE json_extract(route_json, '$.target') = ${localTarget}`;
      expect(retained[0]?.count).toBe(MAX_REMOTE_AGENT_TERMINAL_OWNERS);
    }),
  );
  it.effect("ordinary unscoped SSH terminal replacement retains its existing behavior", () =>
    Effect.gen(function* () {
      const owners = yield* makeRemoteAgentRuntimeBindings;
      const previous = {
        ...profileOwner(),
        ownerKey: "terminal:legacy",
        state: "terminal" as const,
      };
      yield* Effect.promise(() => owners.reserve(previous));
      const next = { ...previous, state: "prepared" as const, resourceId: "replacement" };
      expect(yield* Effect.promise(() => owners.reserve(next, true))).toEqual(next);
    }),
  );
});
