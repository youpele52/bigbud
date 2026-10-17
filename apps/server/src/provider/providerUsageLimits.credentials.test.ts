import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  cursorCredentialDatabasePath,
  cursorUsageCredentialFromToken,
  readCursorUsageCredential,
} from "./Layers/Cursor/Provider.usageLimits.credentials.ts";
import { readOpencodeGoUsageCredential } from "./Layers/Opencode/Provider.usageLimits.credentials.ts";

const directories: string[] = [];

async function directory() {
  const path = await mkdtemp(join(tmpdir(), "bigbud-quota-credentials-"));
  directories.push(path);
  return path;
}

function token(payload = { sub: "auth0|user_fixture", exp: Date.now() / 1000 + 3600 }) {
  return `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.fixture`;
}

async function cursorDatabase(value: string | Buffer, wal = false) {
  const home = await directory();
  const path = join(home, "state.vscdb");
  const db = new DatabaseSync(path);
  if (wal) db.exec("PRAGMA journal_mode=WAL");
  db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)");
  db.prepare("INSERT INTO ItemTable VALUES (?, ?)").run("cursorAuth/accessToken", value);
  return { home, path, db };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("read-only Cursor desktop credentials", () => {
  it("resolves known platform paths without relative environment overrides", () => {
    expect(cursorCredentialDatabasePath("darwin", "/fixture", {})).toBe(
      "/fixture/Library/Application Support/Cursor/User/globalStorage/state.vscdb",
    );
    expect(cursorCredentialDatabasePath("linux", "/fixture", { XDG_CONFIG_HOME: "/config" })).toBe(
      "/config/Cursor/User/globalStorage/state.vscdb",
    );
    expect(cursorCredentialDatabasePath("linux", "/fixture", { XDG_CONFIG_HOME: "relative" })).toBe(
      "/fixture/.config/Cursor/User/globalStorage/state.vscdb",
    );
    expect(cursorCredentialDatabasePath("win32", "/fixture", {})).toBeUndefined();
    expect(cursorCredentialDatabasePath("aix", "/fixture", {})).toBeUndefined();
  });

  it("constructs a dashboard session from an existing JWT without renewing it", () => {
    const jwt = token();
    expect(cursorUsageCredentialFromToken(jwt)).toEqual({
      secret: jwt,
      headers: { Cookie: `WorkosCursorSessionToken=user_fixture%3A%3A${jwt}` },
    });
    expect(
      cursorUsageCredentialFromToken(token({ sub: "fixture", exp: Date.now() / 1000 + 30 })),
    ).toBeUndefined();
    expect(cursorUsageCredentialFromToken(undefined)).toBeUndefined();
  });

  it.each(["invalid", token({ sub: "user;injected", exp: Date.now() / 1000 + 3600 })])(
    "rejects invalid sessions without exposing their contents",
    (jwt) => {
      expect(() => cursorUsageCredentialFromToken(jwt)).toThrow(/Invalid Cursor session/);
    },
  );

  it.each(["text", "utf8", "utf16le"] as const)(
    "reads %s storage without changing the database or creating sidecars",
    async (encoding) => {
      const jwt = token();
      const { home, path, db } = await cursorDatabase(
        encoding === "text" ? jwt : Buffer.from(jwt, encoding),
      );
      db.close();
      const before = await readFile(path);
      const modified = (await stat(path)).mtimeMs;
      expect((await readCursorUsageCredential(path))?.secret).toBe(jwt);
      expect(await readFile(path)).toEqual(before);
      expect((await stat(path)).mtimeMs).toBe(modified);
      expect(await readdir(home)).toEqual(["state.vscdb"]);
    },
  );

  it("reads the current WAL login rather than a checkpointed former account", async () => {
    const previous = token({ sub: "previous", exp: Date.now() / 1000 + 3600 });
    const next = token();
    const { path, db } = await cursorDatabase(previous, true);
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      db.prepare("UPDATE ItemTable SET value = ? WHERE key = ?").run(
        next,
        "cursorAuth/accessToken",
      );
      const beforeDb = await readFile(path);
      const beforeWal = await readFile(`${path}-wal`);
      expect((await readCursorUsageCredential(path))?.secret).toBe(next);
      expect(await readFile(path)).toEqual(beforeDb);
      expect(await readFile(`${path}-wal`)).toEqual(beforeWal);
    } finally {
      db.close();
    }
  });

  it("does not create a missing credential store", async () => {
    const home = await directory();
    expect(await readCursorUsageCredential(join(home, "absent.db"))).toBeUndefined();
    expect(await readdir(home)).toEqual([]);
  });
});

describe("provider-scoped OpenCode Go credentials", () => {
  async function fixture(record: unknown) {
    const home = await directory();
    const root = join(home, ".local", "share", "opencode");
    await mkdir(root, { recursive: true });
    const path = join(root, "auth.json");
    await writeFile(path, JSON.stringify(record));
    return { home, path };
  }

  it("reads only the Go API entry without writing the file", async () => {
    const { home, path } = await fixture({
      opencode: { type: "api", key: "zen-key" },
      "opencode-go": { type: "api", key: "go-key" },
    });
    const before = await readFile(path);
    const modified = (await stat(path)).mtimeMs;
    expect(await readOpencodeGoUsageCredential({ home, env: {} })).toEqual({
      secret: "go-key",
      headers: { Authorization: "Bearer go-key" },
    });
    expect(await readFile(path)).toEqual(before);
    expect((await stat(path)).mtimeMs).toBe(modified);
  });

  it.each([
    { opencode: { type: "api", key: "zen-key" } },
    { "opencode-go": { type: "oauth", access: "oauth-secret" } },
    { "opencode-go": { type: "api", key: "" } },
  ])("does not use unrelated or absent credentials", async (record) => {
    const { home } = await fixture(record);
    expect(
      await readOpencodeGoUsageCredential({ home, env: { OPENCODE_API_KEY: "unscoped-key" } }),
    ).toBeUndefined();
  });

  it("accepts an explicit Go environment key without needing a credential file", async () => {
    const home = await directory();
    expect(
      (await readOpencodeGoUsageCredential({ home, env: { OPENCODE_GO_API_KEY: "go-key" } }))
        ?.secret,
    ).toBe("go-key");
    expect(await readdir(home)).toEqual([]);
  });

  it("supports absolute XDG data paths", async () => {
    const home = await directory();
    const root = join(home, "xdg");
    await mkdir(join(root, "opencode"), { recursive: true });
    await writeFile(
      join(root, "opencode", "auth.json"),
      JSON.stringify({ "opencode-go": { type: "api", key: "go-key" } }),
    );
    expect(
      (await readOpencodeGoUsageCredential({ home, env: { XDG_DATA_HOME: root } }))?.secret,
    ).toBe("go-key");
  });

  it("rejects oversized files and header injection", async () => {
    const { home, path } = await fixture({ "opencode-go": { type: "api", key: "go\r\ninjected" } });
    await expect(readOpencodeGoUsageCredential({ home, env: {} })).rejects.toThrow(
      "Invalid OpenCode Go API key",
    );
    await writeFile(path, "x".repeat(256 * 1024 + 1));
    await expect(readOpencodeGoUsageCredential({ home, env: {} })).rejects.toThrow(
      "Invalid OpenCode credential file",
    );
  });
});
