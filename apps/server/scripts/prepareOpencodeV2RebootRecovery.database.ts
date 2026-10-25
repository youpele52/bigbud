import { DatabaseSync } from "node:sqlite";
import { lstatSync } from "node:fs";
import { createHash } from "node:crypto";

/** No state UUID exists: require identical application schema and nonempty durable event-ID ledger.
 * This proves selected-state journal lineage at the read snapshot, not a unique physical database ID.
 * The ledger survives event compaction; counts alone or a self-supplied checksum are not association. */
function journalIdentity(db: DatabaseSync) {
  const schema = db
    .prepare(`SELECT type, name, tbl_name, sql FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`)
    .all();
  const hash = createHash("sha256").update(JSON.stringify(schema));
  let count = 0;
  for (const row of db
    .prepare(`SELECT event_id, sequence FROM orchestration_event_ids
    ORDER BY event_id`)
    .iterate()) {
    if (typeof row.event_id !== "string" || !row.event_id || !Number.isSafeInteger(row.sequence))
      throw new Error("Recovery database backup has invalid journal identity evidence.");
    hash.update(JSON.stringify([row.event_id, row.sequence]));
    count++;
  }
  if (!count)
    throw new Error("Recovery database backup has no selected-state journal identity evidence.");
  return { count, digest: hash.digest("hex") };
}

/** Keep readonly snapshots alive through approval publication; never migrate or repair either database. */
export async function withV2RecoveryDatabase<T>(
  filename: string,
  selected: string | undefined,
  assertBackup: () => void,
  run: (assertCurrent: () => void) => Promise<T>,
) {
  const backup = new DatabaseSync(filename, { readOnly: true });
  let source: DatabaseSync | undefined;
  try {
    backup.exec("BEGIN");
    const result = backup.prepare("PRAGMA integrity_check").all();
    if (result.length !== 1 || result[0]?.integrity_check !== "ok")
      throw new Error("Recovery database backup failed SQLite integrity_check.");
    let assertSource = () => {};
    if (selected) {
      const identity = lstatSync(selected);
      if (
        !identity.isFile() ||
        identity.isSymbolicLink() ||
        identity.nlink !== 1 ||
        identity.uid !== process.getuid?.() ||
        identity.mode & 0o077
      )
        throw new Error("Recovery selected-state database is not private regular evidence.");
      assertSource = () => {
        const current = lstatSync(selected);
        if (
          !current.isFile() ||
          current.dev !== identity.dev ||
          current.ino !== identity.ino ||
          current.uid !== identity.uid ||
          current.mode !== identity.mode ||
          current.nlink !== 1
        )
          throw new Error("Recovery selected-state database identity changed.");
      };
      source = new DatabaseSync(selected, { readOnly: true });
      source.exec("BEGIN");
      const saved = journalIdentity(backup),
        current = journalIdentity(source);
      if (saved.count !== current.count || saved.digest !== current.digest)
        throw new Error(
          "Recovery database backup does not match the selected-state schema/journal identity.",
        );
    }
    const assertCurrent = () => {
      assertBackup();
      assertSource();
    };
    assertCurrent();
    return await run(assertCurrent);
  } finally {
    source?.close();
    backup.close();
  }
}
