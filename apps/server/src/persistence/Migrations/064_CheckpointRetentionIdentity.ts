import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE purge_checkpoint_ref_sets ADD COLUMN repository_kind TEXT CHECK (repository_kind IN ('git', 'non-git'))`;
  yield* sql`ALTER TABLE purge_checkpoint_ref_sets ADD COLUMN workspace_canonical_path TEXT`;
  yield* sql`ALTER TABLE purge_checkpoint_ref_sets ADD COLUMN workspace_device INTEGER`;
  yield* sql`ALTER TABLE purge_checkpoint_ref_sets ADD COLUMN workspace_inode INTEGER`;
  yield* sql`ALTER TABLE purge_checkpoint_ref_sets ADD COLUMN git_common_dir_canonical_path TEXT`;
  yield* sql`ALTER TABLE purge_checkpoint_ref_sets ADD COLUMN git_common_dir_device INTEGER`;
  yield* sql`ALTER TABLE purge_checkpoint_ref_sets ADD COLUMN git_common_dir_inode INTEGER`;
  yield* sql`ALTER TABLE purge_checkpoint_ref_sets ADD COLUMN verified_at TEXT`;
  yield* sql`
    CREATE TRIGGER purge_checkpoint_verification_before_complete
    BEFORE UPDATE OF status ON purge_jobs
    WHEN NEW.entity_kind = 'thread' AND NEW.status = 'completed' AND NOT EXISTS (
      SELECT 1 FROM purge_checkpoint_ref_sets AS checkpoint_set
      WHERE checkpoint_set.job_id = NEW.job_id AND checkpoint_set.verified_at IS NOT NULL
    )
    BEGIN SELECT RAISE(ABORT, 'thread checkpoint deletion is not verified'); END
  `;
});
