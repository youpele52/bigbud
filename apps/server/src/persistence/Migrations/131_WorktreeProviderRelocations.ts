import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Additive provider intents and lineage never rewrite native cursors or historical admissions. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE worktree_provider_relocations (
    plan_digest TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES worktree_operations(operation_id),
    thread_id TEXT NOT NULL, provider TEXT NOT NULL, plan_json TEXT NOT NULL,
    phase TEXT NOT NULL CHECK(phase IN ('prepared','dispatched','verified')), error TEXT, failure_code TEXT
  )`;
  yield* sql`CREATE INDEX worktree_provider_relocations_owner ON worktree_provider_relocations(operation_id,thread_id)`;
  yield* sql`CREATE TABLE worktree_provider_lineage (
    plan_digest TEXT PRIMARY KEY REFERENCES worktree_provider_relocations(plan_digest),
    operation_id TEXT NOT NULL, thread_id TEXT NOT NULL, source_cwd TEXT NOT NULL,
    destination_cwd TEXT NOT NULL, verified_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX worktree_provider_lineage_destination ON worktree_provider_lineage(thread_id,destination_cwd)`;
  yield* sql`CREATE TRIGGER worktree_provider_plan_immutable BEFORE UPDATE OF
    plan_digest,operation_id,thread_id,provider,plan_json ON worktree_provider_relocations
    BEGIN SELECT RAISE(ABORT,'worktree provider intent is immutable'); END`;
  yield* sql`CREATE TRIGGER worktree_provider_phase_monotonic BEFORE UPDATE OF phase ON worktree_provider_relocations
    WHEN NOT (NEW.phase = OLD.phase OR (OLD.phase = 'prepared' AND NEW.phase = 'dispatched') OR
      (OLD.phase = 'dispatched' AND NEW.phase = 'verified'))
    BEGIN SELECT RAISE(ABORT,'worktree provider phase cannot rewind'); END`;
  yield* sql`CREATE TRIGGER worktree_provider_lineage_immutable BEFORE UPDATE ON worktree_provider_lineage
    BEGIN SELECT RAISE(ABORT,'worktree provider lineage is immutable'); END`;
  yield* sql`CREATE TRIGGER worktree_provider_intent_retained BEFORE DELETE ON worktree_provider_relocations
    BEGIN SELECT RAISE(ABORT,'worktree provider intent cannot be discarded'); END`;
  yield* sql`CREATE TRIGGER worktree_provider_lineage_verified BEFORE INSERT ON worktree_provider_lineage
    WHEN NOT EXISTS (SELECT 1 FROM worktree_provider_relocations p JOIN worktree_operations o ON o.operation_id = p.operation_id
      WHERE p.plan_digest = NEW.plan_digest AND p.phase = 'verified' AND o.phase IN ('moved','references')
        AND p.operation_id = NEW.operation_id AND p.thread_id = NEW.thread_id
        AND json_extract(p.plan_json,'$.request.sourceCwd') = NEW.source_cwd
        AND json_extract(p.plan_json,'$.request.destinationCwd') = NEW.destination_cwd)
    BEGIN SELECT RAISE(ABORT,'worktree provider lineage requires a verified intent'); END`;
  yield* sql`CREATE TRIGGER worktree_provider_lineage_retained BEFORE DELETE ON worktree_provider_lineage
    BEGIN SELECT RAISE(ABORT,'worktree provider lineage cannot be discarded'); END`;
});
