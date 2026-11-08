import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  ThreadOrganizationRuntimeRepository,
  type ThreadOrganizationRuntimeRepositoryShape,
} from "../Services/ThreadOrganizationRuntime.ts";
import { makeReconcileOrganizationPolicy } from "./ThreadOrganizationRuntime.policy.ts";
import { makeOrganizationRuntimeQueries } from "./ThreadOrganizationRuntime.queries.ts";

// Policy identity/barriers and thread reads. No timers, native process, settings writes or
// projection replay hooks are created by constructing this layer.
export const makeThreadOrganizationRuntimeRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const queries = makeOrganizationRuntimeQueries(sql);
  return {
    readPolicy: () =>
      queries
        .policy()
        .pipe(Effect.mapError(toPersistenceSqlError("ThreadOrganizationRuntime.readPolicy"))),
    readThread: (threadId) =>
      queries
        .thread(threadId)
        .pipe(Effect.mapError(toPersistenceSqlError("ThreadOrganizationRuntime.readThread"))),
    reconcilePolicy: makeReconcileOrganizationPolicy(sql, queries),
  } satisfies ThreadOrganizationRuntimeRepositoryShape;
});
export const ThreadOrganizationRuntimeRepositoryLive = Layer.effect(
  ThreadOrganizationRuntimeRepository,
  makeThreadOrganizationRuntimeRepository,
);
