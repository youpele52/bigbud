import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect, it } from "vitest";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { OpencodeV2SharedBindingsLive } from "./OpencodeV2SharedBindings.ts";
import { OpencodeV2SharedBindings } from "../Services/OpencodeV2SharedBindings.ts";

const material = {
  threadId: "durable-thread",
  nativeSessionId: "native-exact",
  storageIdentity: "opaque-history",
  directory: "/fixture/location",
  runtimeTargetId: "local",
  workspaceTargetId: "local",
  identityKind: "shared-api-v1" as const,
  material: "initial-model-digest",
};
const layer = Layer.provideMerge(OpencodeV2SharedBindingsLive, SqlitePersistenceMemory);

it("retains immutable material with one reservation/CAS winner and no rollback from verified/intent", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const repo = yield* OpencodeV2SharedBindings;
      expect(yield* repo.hasRecords).toBe(false);
      const row = yield* repo.reserve(material);
      expect(
        yield* Effect.result(repo.transition({ ...row, nativeSessionId: "forged" }, "verified")),
      ).toMatchObject({ _tag: "Failure" });
      expect(yield* repo.reserve(material)).toEqual(row);
      expect(
        yield* Effect.result(repo.reserve({ ...material, storageIdentity: "different" })),
      ).toMatchObject({ _tag: "Failure" });
      const winners = yield* Effect.all(
        [
          repo.transition(row, "dispatch-intent").pipe(Effect.result),
          repo.transition(row, "dispatch-intent").pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      );
      expect(winners.filter((result) => result._tag === "Success")).toHaveLength(1);
      const intent = yield* repo.find(material.threadId);
      expect(intent).toMatchObject({ ...material, state: "dispatch-intent", revision: 1 });
      expect(yield* repo.hasRecords).toBe(true);
      expect(yield* Effect.result(repo.transition(row, "verified"))).toMatchObject({
        _tag: "Failure",
      });
      const verified = yield* repo.transition(intent!, "verified");
      expect(yield* repo.reserve(material)).toEqual(verified);
      expect(yield* Effect.result(repo.transition(verified, "dispatch-intent"))).toMatchObject({
        _tag: "Failure",
      });
      expect(yield* repo.find(material.threadId)).toEqual(verified);
    }).pipe(Effect.provide(layer)),
  );
});

it("a corrupt persisted binding is not missing history and cannot be recreated", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repo = yield* OpencodeV2SharedBindings;
      yield* repo.reserve(material);
      yield* sql`UPDATE opencode_v2_shared_bindings SET material_json = 'invalid' WHERE thread_id = ${material.threadId}`;
      expect(yield* Effect.result(repo.find(material.threadId))).toMatchObject({ _tag: "Failure" });
      expect(yield* Effect.result(repo.reserve(material))).toMatchObject({ _tag: "Failure" });
      expect(yield* repo.hasRecords).toBe(true);
    }).pipe(Effect.provide(layer)),
  );
});
