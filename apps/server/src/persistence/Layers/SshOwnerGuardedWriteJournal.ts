import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { SSH_OWNER_PRODUCTION_ACTIVATION } from "@bigbud/shared/SshOwnerActivation";

import { isSshOwnerDevFixtureSelected } from "../../ssh/sshOwnerSelection.ts";
import { initializeSshGuardedWriteJournal } from "./SshGuardedWriteJournal.ts";

/**
 * W2 T-files: the production owner's guarded-save journal in the server's own
 * state database, with the dev fixture's semantics (one autocommitted claim per
 * operation id authorizes exactly one APPLY; receipts are recorded once; no
 * expiry or re-arming). Rows bind the exact target and target generation.
 */
export const initializeProductionSshGuardedWriteJournal = Effect.fn(
  "initializeProductionSshGuardedWriteJournal",
)(function* (sql: SqlClient.SqlClient, activation: boolean = SSH_OWNER_PRODUCTION_ACTIVATION) {
  return yield* initializeSshGuardedWriteJournal(sql, {
    table: "ssh_owner_guarded_write_journal",
    admitted: () => activation && !isSshOwnerDevFixtureSelected(),
    label: "Production SSH owner",
  });
});
