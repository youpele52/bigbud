import {
  ApprovalRequestId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@bigbud/contracts/core/baseSchemas.ts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ProjectionPendingUserInputRepositoryLive } from "./ProjectionPendingUserInputs.ts";
import { ProjectionPendingUserInputRepository } from "../Services/ProjectionPendingUserInputs.ts";

const layer = it.layer(
  ProjectionPendingUserInputRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionPendingUserInputRepository", (it) => {
  it.effect("stores structured questions and deletes rows by thread and project", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionPendingUserInputRepository;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.makeUnsafe("input-project");
      const threadId = ThreadId.makeUnsafe("input-thread");
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, purpose, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at
        ) VALUES (
          ${threadId}, ${projectId}, 'Thread', 'standard',
          '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
          '2026-01-01', '2026-01-01'
        )
      `;
      const requestId = ApprovalRequestId.makeUnsafe("input-request");
      yield* repository.upsert({
        requestId,
        threadId,
        turnId: TurnId.makeUnsafe("turn-1"),
        status: "pending",
        questions: [
          {
            id: "choice",
            header: "Choice",
            question: "Continue?",
            options: [{ label: "Yes", description: "Continue" }],
            multiSelect: false,
          },
        ],
        createdAt: "2026-01-01",
        resolvedAt: null,
      });
      const stored = yield* repository.getByRequestId({ requestId });
      assert.equal(Option.getOrNull(stored)?.questions[0]?.id, "choice");

      yield* repository.deleteByProjectId({ projectId });
      assert.equal(Option.isNone(yield* repository.getByRequestId({ requestId })), true);

      yield* repository.upsert({
        requestId,
        threadId,
        turnId: null,
        status: "pending",
        questions: [],
        createdAt: "2026-01-01",
        resolvedAt: null,
      });
      yield* repository.deleteByThreadId({ threadId });
      assert.equal(Option.isNone(yield* repository.getByRequestId({ requestId })), true);
    }),
  );
});
