import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, writeFile, rename, unlink, mkdir, rmdir } from "node:fs/promises";
import { Schema } from "effect";

export type ProviderConfig = Record<string, unknown>;
const decodeConfig = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));

// Unlike the general lenient decoder, preserve comma/bracket sequences inside credential strings.
function parseConfig(text: string) {
  const withoutComments = text.replace(
    /("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (match, quoted: string | undefined) => quoted ?? " ",
  );
  const json = withoutComments.replace(
    /("(?:[^"\\]|\\.)*")|,(\s*[}\]])/g,
    (match, quoted: string | undefined, closing: string | undefined) => quoted ?? closing ?? match,
  );
  return decodeConfig(JSON.parse(json));
}

export function isProviderConfig(value: unknown): value is ProviderConfig {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Missing files are optional; malformed or linked files must never be silently replaced. */
export async function readProviderConfig(path: string) {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return undefined;
  if (!info.isFile() || info.nlink !== 1 || info.size > 1024 * 1024) {
    throw new Error(
      `Provider configuration migration refused non-regular or oversized file: ${path}`,
    );
  }
  const text = await readFile(path, "utf8");
  try {
    return { text, value: parseConfig(text) };
  } catch {
    throw new Error(`Provider configuration is not a valid JSON object: ${path}`);
  }
}

/** Back up exact original bytes before atomically publishing a changed configuration. */
export async function writeProviderConfig(
  path: string,
  original: Awaited<ReturnType<typeof readProviderConfig>>,
  value: ProviderConfig,
) {
  if (original && JSON.stringify(original.value) === JSON.stringify(value)) return;
  const current = await readProviderConfig(path);
  if (current?.text !== original?.text) throw new Error(`Provider configuration changed: ${path}`);
  if (original) {
    const digest = createHash("sha256").update(original.text).digest("hex");
    const backup = `${path}.bigbud-${digest}.bak`;
    await writeFile(backup, original.text, { mode: 0o600, flag: "wx" }).catch(
      async (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST" || (await readFile(backup, "utf8")) !== original.text)
          throw error;
      },
    );
  }
  const temporary = `${path}.bigbud-${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    if ((await readProviderConfig(path))?.text !== original?.text) {
      throw new Error(`Provider configuration changed: ${path}`);
    }
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

const pendingMigrations = new Map<string, Promise<void>>();

/** Serialize launches within this server without permanently caching user configuration. */
export async function withProviderConfigMigration(key: string, migrate: () => Promise<void>) {
  const pending = pendingMigrations.get(key);
  if (pending) return pending;
  const task = (async () => {
    const lock = `${key}.bigbud-migration.lock`;
    try {
      await mkdir(lock, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error(
        `Provider migration lock unavailable: ${lock}. Check for another server or a stale lock before retrying.`,
        { cause: error },
      );
    }
    try {
      await migrate();
    } finally {
      await rmdir(lock);
    }
  })();
  pendingMigrations.set(key, task);
  try {
    await task;
  } finally {
    pendingMigrations.delete(key);
  }
}
