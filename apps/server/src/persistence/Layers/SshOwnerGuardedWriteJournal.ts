import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { initializeSshGuardedWriteJournal } from "./SshGuardedWriteJournal.ts";

/**
 * W2 T-files: the production owner's guarded-save journal in the server's own
 * state database (one autocommitted claim per operation id authorizes exactly one APPLY; receipts are recorded once; no
 * expiry or re-arming). Rows bind the exact target and target generation.
 */
export const initializeProductionSshGuardedWriteJournal = Effect.fn(
  "initializeProductionSshGuardedWriteJournal",
)(function* (sql: SqlClient.SqlClient) {
  return yield* initializeSshGuardedWriteJournal(sql, {
    table: "ssh_owner_guarded_write_journal",
    admitted: () => true,
    label: "Production SSH owner",
  });
});
