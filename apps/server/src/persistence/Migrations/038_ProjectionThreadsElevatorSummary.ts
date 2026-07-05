import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ensureProjectionThreadsElevatorSummaryColumns } from "./ProjectionThreadsElevatorSummary.columns.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* ensureProjectionThreadsElevatorSummaryColumns(sql);
});
