import { ThreadId, TurnId } from "@bigbud/contracts";
import { Effect, Layer, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect, it } from "vitest";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { VisibleBrowserControl } from "../Services/VisibleBrowserControl.ts";
import { VisibleBrowserControlLive } from "./VisibleBrowserControl.ts";

const layer = VisibleBrowserControlLive.pipe(Layer.provideMerge(SqlitePersistenceMemory));

it("atomically rejects a new visible tab after deletion ownership commits", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const control = yield* VisibleBrowserControl;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.makeUnsafe("visible-browser-deleting-thread");
      yield* Stream.runDrain(control.streamCommands("retention-renderer")).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* sql`
        INSERT INTO orchestration_deletion_markers (
          entity_kind, entity_id, deletion_sequence, deleted_at
        ) VALUES ('thread', ${threadId}, 1, '2026-08-04T00:00:00.000Z')
      `;

      expect(
        (yield* Effect.exit(
          control.execute({
            threadId,
            turnId: TurnId.makeUnsafe("visible-browser-deleting-turn"),
            action: { action: "capture", target: "visible" },
          }),
        ))._tag,
      ).toBe("Failure");
      expect(
        yield* sql<{ count: number }>`
          SELECT COUNT(*) AS count FROM thread_activity_leases WHERE thread_id = ${threadId}
        `,
      ).toEqual([{ count: 0 }]);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
});
