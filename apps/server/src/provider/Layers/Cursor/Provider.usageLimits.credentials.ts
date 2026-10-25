import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { usageRecord } from "../../providerUsageLimits.ts";
import type { UsageCredential } from "../../providerUsageLimits.http.ts";

/** Resolves only Cursor's known desktop credential database; never opens browser stores. */
export function cursorCredentialDatabasePath(
  platform = process.platform,
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const suffix = ["Cursor", "User", "globalStorage", "state.vscdb"];
  if (platform === "darwin") return join(home, "Library", "Application Support", ...suffix);
  if (platform === "win32")
    return env.APPDATA && isAbsolute(env.APPDATA) ? join(env.APPDATA, ...suffix) : undefined;
  if (platform === "linux")
    return join(
      env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME)
        ? env.XDG_CONFIG_HOME
        : join(home, ".config"),
      ...suffix,
    );
  return undefined;
}

/** Reads a desktop session without renewing it or writing credential/database files. */
export async function readCursorUsageCredential(
  databasePath = cursorCredentialDatabasePath(),
): Promise<UsageCredential | undefined> {
  if (!databasePath || !(await exists(databasePath))) return undefined;
  const [wal, shm] = await Promise.all([
    exists(`${databasePath}-wal`),
    exists(`${databasePath}-shm`),
  ]);
  // Do not create sidecars or ignore active WAL state when Cursor is publishing a login.
  if (wal !== shm) throw new Error("Cursor credential database is changing.");
  const filename = wal ? databasePath : `${pathToFileURL(databasePath).href}?immutable=1`;
  const database = new DatabaseSync(filename, { readOnly: true, timeout: 250 });
  let value: unknown;
  try {
    value = database
      .prepare("SELECT value FROM ItemTable WHERE key = ? LIMIT 1")
      .get("cursorAuth/accessToken")?.value;
  } finally {
    database.close();
  }
  if (
    wal !== (await exists(`${databasePath}-wal`)) ||
    shm !== (await exists(`${databasePath}-shm`))
  ) {
    throw new Error("Cursor credential database changed during the read.");
  }
  return cursorUsageCredentialFromToken(decodeToken(value));
}

/** Converts the existing desktop JWT to the dashboard cookie, as CodexBar does. */
export function cursorUsageCredentialFromToken(
  token: string | undefined,
  now = Date.now(),
): UsageCredential | undefined {
  if (!token) return undefined;
  if (token.length > 16 * 1024) throw new Error("Cursor session exceeds size limit.");
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))
    throw new Error("Invalid Cursor session.");
  const payload = usageRecord(
    JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")),
  );
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp))
    throw new Error("Invalid Cursor session expiry.");
  if (payload.exp * 1000 <= now + 60_000) return undefined;
  const subject = typeof payload.sub === "string" ? payload.sub.split("|").at(-1) : undefined;
  if (!subject || !/^[A-Za-z0-9._-]+$/.test(subject))
    throw new Error("Invalid Cursor session identity.");
  return {
    secret: token,
    headers: { Cookie: `WorkosCursorSessionToken=${subject}%3A%3A${token}` },
  };
}

function decodeToken(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return value;
  if (!(value instanceof Uint8Array)) throw new Error("Invalid Cursor credential encoding.");
  const buffer = Buffer.from(value);
  const isUtf16 =
    buffer.length % 2 === 0 &&
    buffer.every((byte, index) => (index % 2 === 0 ? byte > 0 && byte < 128 : byte === 0));
  return buffer.toString(isUtf16 ? "utf16le" : "utf8");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
