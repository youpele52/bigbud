import * as ServiceMap from "effect/ServiceMap";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

/** Independent read-only connection: usage scans must not hold the operational SQL queue. */
export const UsageSqlClient = ServiceMap.Service<SqlClient.SqlClient>(
  "bigbud/persistence/UsageSqlClient",
);
