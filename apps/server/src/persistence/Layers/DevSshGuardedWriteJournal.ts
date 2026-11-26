import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { isSshOwnerDevFixtureSelected } from "../../ssh/sshOwnerSelection.ts";
import { initializeSshGuardedWriteJournal } from "./SshGuardedWriteJournal.ts";

export type {
  DevSshGuardedWriteBinding,
  DevSshGuardedWriteReceipt,
} from "./SshGuardedWriteJournal.ts";

/** The source-dev fixture's journal (unchanged table and semantics). */
export const initializeDevSshGuardedWriteJournal = Effect.fn("initializeDevSshGuardedWriteJournal")(
  function* (sql: SqlClient.SqlClient, capacity?: number) {
    return yield* initializeSshGuardedWriteJournal(
      sql,
      {
        table: "dev_ssh_guarded_write_journal",
        admitted: isSshOwnerDevFixtureSelected,
        label: "Source-dev SSH owner",
      },
      capacity,
    );
  },
);
