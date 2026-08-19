import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { rebuildPolicyCheckTable } from "./097_ThreadRetentionFinitePolicies.rebuild.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* rebuildPolicyCheckTable(sql, "thread_retention_consent_challenges");
  yield* rebuildPolicyCheckTable(sql, "thread_retention_policy_authority");
  yield* rebuildPolicyCheckTable(sql, "thread_retention_runs", {
    children: ["thread_retention_run_items", "thread_retention_failures"],
  });
});
