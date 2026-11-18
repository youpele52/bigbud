import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Late readiness may fill a missing thread path once, without rewriting captured job inputs. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE thread_metadata_generation_model_bindings (
    job_id TEXT PRIMARY KEY REFERENCES thread_metadata_generation_jobs(job_id),
    path_json TEXT NOT NULL CHECK(json_valid(path_json)),
    verified_model_json TEXT NOT NULL CHECK(json_valid(verified_model_json)),
    bound_at TEXT NOT NULL
  )`;
});
