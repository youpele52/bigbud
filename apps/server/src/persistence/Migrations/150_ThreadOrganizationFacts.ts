import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { OrganizationMigrationContext } from "../OrganizationMigrationContext.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const context = yield* Effect.serviceOption(OrganizationMigrationContext);
  const classification =
    Option.isSome(context) && context.value.newInstallation ? "new" : "existing";
  yield* sql`ALTER TABLE thread_organization_runtime_threads ADD COLUMN semantic_digest TEXT NOT NULL DEFAULT ''`;
  yield* sql`ALTER TABLE thread_organization_runtime_threads ADD COLUMN last_work_state TEXT NOT NULL DEFAULT 'unknown'
    CHECK (last_work_state IN ('idle', 'active', 'unknown'))`;
  yield* sql`ALTER TABLE thread_organization_runtime_threads ADD COLUMN manual_attention_watermark INTEGER NOT NULL DEFAULT 0
    CHECK (manual_attention_watermark BETWEEN 0 AND 9007199254740991)`;
  yield* sql`ALTER TABLE thread_organization_runtime_threads ADD COLUMN attention_ids_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(attention_ids_json) AND length(attention_ids_json) <= 32768)`;
  yield* sql`CREATE TABLE thread_organization_installation (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    classification TEXT NOT NULL CHECK (classification IN ('new', 'existing'))
  )`;
  yield* sql`INSERT INTO thread_organization_installation (singleton, classification) VALUES (1, ${classification})`;
});
