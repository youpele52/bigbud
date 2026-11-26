const SESSION_QUERY = "SELECT value FROM ItemTable WHERE key = ? LIMIT 1";
const SESSION_KEY = "cursorAuth/accessToken";
const BUSY_TIMEOUT_MS = 250;

/** Both runtime adapters use read-only SQLite, including when filename is an immutable URI. */
export async function readCursorSessionValue(filename: string): Promise<unknown> {
  if (process.versions.bun !== undefined) {
    const { Database, constants } = await import("bun:sqlite");
    const database = new Database(
      filename,
      constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI,
    );
    try {
      database.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      return database.query<{ value: unknown }, [string]>(SESSION_QUERY).get(SESSION_KEY)?.value;
    } finally {
      database.close();
    }
  }

  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(filename, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
  try {
    return database.prepare(SESSION_QUERY).get(SESSION_KEY)?.value;
  } finally {
    database.close();
  }
}
