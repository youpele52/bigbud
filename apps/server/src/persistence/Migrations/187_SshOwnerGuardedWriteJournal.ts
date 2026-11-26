import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { createSshGuardedWriteJournalTable } from "../Layers/SshGuardedWriteJournal.ts";

// W2 T-files: the production SSH owner's guarded-save journal. Build B-side
// table, above the Build A schema ceiling (184/185). Same DDL as the journal's
// own first-use bootstrap, so either order leaves one identical table.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* createSshGuardedWriteJournalTable(sql, "ssh_owner_guarded_write_journal");
});
