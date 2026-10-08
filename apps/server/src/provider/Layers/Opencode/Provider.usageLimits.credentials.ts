import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { UsageCredential } from "../../providerUsageLimits.http.ts";
import { usageRecord } from "../../providerUsageLimits.ts";

/** Reads the existing CLI's Go auth.json entry or an explicit Go environment key. */
export async function readOpencodeGoUsageCredential(options?: {
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<UsageCredential | undefined> {
  const env = options?.env ?? process.env;
  const home = options?.home ?? homedir();
  // A generic OPENCODE_API_KEY may belong to Zen rather than Go, so do not guess its scope.
  const configured = env.OPENCODE_GO_API_KEY?.trim();
  if (configured) return credential(configured);
  // This is the current integration's legacy store, not V2's SQLite account store.
  // Do not infer private V2 tables or select another model-provider credential.
  const root =
    env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME)
      ? env.XDG_DATA_HOME
      : join(home, ".local", "share");
  let file;
  try {
    file = await open(join(root, "opencode", "auth.json"), "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 256 * 1024)
      throw new Error("Invalid OpenCode credential file.");
    const buffer = Buffer.alloc(256 * 1024 + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 256 * 1024) throw new Error("OpenCode credential file exceeds size limit.");
    const record = usageRecord(JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")));
    const entry = record["opencode-go"];
    if (entry == null) return undefined;
    const auth = usageRecord(entry);
    if (auth.type !== "api") return undefined;
    return typeof auth.key === "string" && auth.key.trim()
      ? credential(auth.key.trim())
      : undefined;
  } finally {
    await file.close();
  }
}

function credential(key: string): UsageCredential {
  if (!/^[\x21-\x7E]+$/.test(key)) throw new Error("Invalid OpenCode Go API key.");
  return { secret: key, headers: { Authorization: `Bearer ${key}` } };
}
