import { ThreadId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { BrowserManager } from "../Services/BrowserManager.ts";
import { BrowserManagerLive } from "./BrowserManager.ts";

const layer = BrowserManagerLive.pipe(Layer.provideMerge(SqlitePersistenceMemory));

it.effect("atomically rejects a background browser context after deletion ownership commits", () =>
  Effect.gen(function* () {
    const browser = yield* BrowserManager;
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.makeUnsafe("background-browser-deleting-thread");
    yield* sql`
      INSERT INTO orchestration_deletion_markers (
        entity_kind, entity_id, deletion_sequence, deleted_at
      ) VALUES ('thread', ${threadId}, 1, '2026-08-04T00:00:00.000Z')
    `;

    assert.equal((yield* Effect.exit(browser.launch(threadId)))._tag, "Failure");
    assert.deepEqual(
      yield* sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM thread_activity_leases WHERE thread_id = ${threadId}
      `,
      [{ count: 0 }],
    );
  }).pipe(Effect.provide(layer)),
);
