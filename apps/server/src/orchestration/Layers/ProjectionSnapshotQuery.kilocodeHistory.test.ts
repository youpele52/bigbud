import { OrchestrationReadModel } from "@bigbud/contracts/orchestration/orchestration.thread.ts";
import { assert } from "@effect/vitest";
import { Effect, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { projectionSnapshotLayer } from "./ProjectionSnapshotQuery.test.helpers.ts";

const selection = {
  provider: "kilocode",
  model: "legacy/model",
  subProviderID: "openrouter",
  options: { reasoningEffort: "high" },
} as const;

projectionSnapshotLayer("removed KiloCode history", (it) => {
  it.effect("hydrates and serializes old project and thread selections without rebinding", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const serialized = JSON.stringify(selection);
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json,
          scripts_json, created_at, updated_at, deleted_at
        ) VALUES (
          'kilo-project', 'Old project', '/tmp/kilo-project', ${serialized},
          '[]', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json,
          created_at, updated_at, deleted_at
        ) VALUES (
          'kilo-thread', 'kilo-project', 'Old conversation', ${serialized},
          '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', NULL
        )
      `;

      const snapshot = yield* snapshotQuery.getSnapshot();
      const wire = Schema.encodeSync(OrchestrationReadModel)(snapshot);
      const decoded = Schema.decodeUnknownSync(OrchestrationReadModel)(wire);
      assert.deepStrictEqual(
        decoded.projects.find((project) => project.id === "kilo-project")?.defaultModelSelection,
        selection,
      );
      assert.deepStrictEqual(
        decoded.threads.find((thread) => thread.id === "kilo-thread")?.modelSelection,
        selection,
      );
      const [row] = yield* sql<{ model: string }>`
        SELECT model_selection_json AS model FROM projection_threads WHERE thread_id = 'kilo-thread'
      `;
      assert.deepStrictEqual(JSON.parse(row!.model), selection);
    }),
  );
});
