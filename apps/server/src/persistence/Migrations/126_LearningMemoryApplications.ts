import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE learning_memory_snapshots (
    job_id TEXT PRIMARY KEY REFERENCES learning_jobs(job_id) ON DELETE CASCADE,
    documents_json TEXT NOT NULL CHECK(json_valid(documents_json)))`;
  yield* sql`CREATE TABLE learning_memory_applications (
    job_id TEXT NOT NULL REFERENCES learning_jobs(job_id) ON DELETE CASCADE,
    scope TEXT NOT NULL CHECK(scope IN ('user','global','project')),
    content TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('started','completed')),
    PRIMARY KEY(job_id, scope))`;
});
