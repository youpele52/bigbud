import { backup as sqliteBackup, DatabaseSync } from "node:sqlite";
import {
  chmod,
  copyFile,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { withV2RecoveryBackup } from "./prepareOpencodeV2RebootRecovery.backup.ts";

/** Disposable state only; a nonempty durable ledger is the application's existing lineage authority. */
async function fixture(
  run: (f: {
    root: string;
    source: string;
    backup: string;
    hash: () => Promise<string>;
  }) => Promise<void>,
) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "v2-backup-")));
  try {
    await chmod(root, 0o700);
    const source = path.join(root, "selected.sqlite"),
      backup = path.join(root, "state.sqlite");
    const db = new DatabaseSync(source);
    try {
      db.exec(`CREATE TABLE orchestration_event_ids(event_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL);
        INSERT INTO orchestration_event_ids VALUES ('selected-state-event', 1);
        CREATE TABLE payload(value TEXT);
        INSERT INTO payload VALUES ('preserved');`);
      await sqliteBackup(db, backup);
    } finally {
      db.close();
    }
    await chmod(source, 0o600);
    await chmod(backup, 0o600);
    await run({
      root,
      source,
      backup,
      hash: async () =>
        createHash("sha256")
          .update(await readFile(backup))
          .digest("hex"),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

it.skipIf(process.platform === "win32")(
  "accepts an intact matching selected-state backup and preserves legacy callback behavior",
  async () => {
    await fixture(async (f) => {
      const before = await readFile(f.backup);
      const digest = await f.hash();
      const result = await withV2RecoveryBackup(
        f.backup,
        digest,
        async (observed, assertCurrent) => {
          expect(observed).toBe(digest);
          assertCurrent();
          return "verified";
        },
        f.source,
      );
      expect(result).toBe("verified");
      // Legacy reboot preparation retains its checksum/callback contract and Bun compatibility.
      expect(
        await withV2RecoveryBackup(f.backup, digest, async (_, assertCurrent) => {
          assertCurrent();
          return "legacy";
        }),
      ).toBe("legacy");
      expect(await readFile(f.backup)).toEqual(before);
    });
  },
);

it
  .skipIf(process.platform === "win32")
  .each([
    "arbitrary",
    "truncated",
    "integrity",
    "unrelated",
    "schema",
    "empty-ledger",
    "missing-ledger",
    "sidecar",
    "symlink",
  ])("rejects self-checksummed but invalid backup before approval: %s", async (scenario) => {
  await fixture(async (f) => {
    if (scenario === "arbitrary")
      await writeFile(f.backup, "not a SQLite database", { mode: 0o600 });
    if (scenario === "truncated") {
      const bytes = await readFile(f.backup);
      await writeFile(f.backup, bytes.subarray(0, 150), { mode: 0o600 });
    }
    if (scenario === "integrity") {
      const db = new DatabaseSync(f.backup);
      let page: number;
      let pageSize: number;
      try {
        page = Number(
          db.prepare("SELECT rootpage FROM sqlite_schema WHERE name='payload'").get()!.rootpage,
        );
        pageSize = Number(db.prepare("PRAGMA page_size").get()!.page_size);
      } finally {
        db.close();
      }
      // Corrupt only the payload B-tree, leaving schema and journal lineage readable.
      // Unlike writable_schema, this also works with SQLite defensive mode enabled.
      const bytes = await readFile(f.backup);
      bytes[(page - 1) * pageSize] = 0;
      await writeFile(f.backup, bytes);
      const damaged = new DatabaseSync(f.backup, { readOnly: true });
      try {
        expect(() => damaged.prepare("SELECT value FROM payload").all()).toThrow();
        expect(
          damaged.prepare("SELECT event_id FROM orchestration_event_ids").get()!.event_id,
        ).toBe("selected-state-event");
      } finally {
        damaged.close();
      }
    }
    if (["unrelated", "schema", "empty-ledger", "missing-ledger"].includes(scenario)) {
      const db = new DatabaseSync(f.backup);
      try {
        if (scenario === "unrelated")
          db.exec("UPDATE orchestration_event_ids SET event_id='different-state-event'");
        if (scenario === "schema") db.exec("CREATE TABLE unrelated(value TEXT)");
        if (scenario === "empty-ledger") db.exec("DELETE FROM orchestration_event_ids");
        if (scenario === "missing-ledger") db.exec("DROP TABLE orchestration_event_ids");
      } finally {
        db.close();
      }
    }
    if (scenario === "sidecar") await writeFile(`${f.backup}-wal`, "live", { mode: 0o600 });
    if (scenario === "symlink") {
      await rm(f.backup);
      await symlink(f.source, f.backup);
    }
    const approve = vi.fn(async () => {});
    await expect(withV2RecoveryBackup(f.backup, await f.hash(), approve, f.source)).rejects.toThrow(
      scenario === "integrity" ? /integrity|malformed/i : undefined,
    );
    expect(approve).not.toHaveBeenCalled();
  });
});

it
  .skipIf(process.platform === "win32")
  .each(
    ["replace", "content", "mode", "sidecar"]
      .flatMap((scenario) => [true, false].map((associated) => ({ scenario, associated })))
      .concat([{ scenario: "source-replace", associated: true }]),
  )(
  "retained publication guard rejects $scenario (associated: $associated)",
  async ({ scenario, associated }) => {
    await fixture(async (f) => {
      let approvalPublished = false;
      await expect(
        withV2RecoveryBackup(
          f.backup,
          await f.hash(),
          async (_, assertCurrent) => {
            if (scenario === "replace") {
              await rename(f.backup, `${f.backup}.original`);
              await copyFile(`${f.backup}.original`, f.backup);
            }
            if (scenario === "content") await writeFile(f.backup, "changed", { mode: 0o600 });
            if (scenario === "mode") await chmod(f.backup, 0o644);
            if (scenario === "sidecar") await writeFile(`${f.backup}-wal`, "live", { mode: 0o600 });
            if (scenario === "source-replace") {
              await rename(f.source, `${f.source}.original`);
              await copyFile(`${f.source}.original`, f.source);
            }
            assertCurrent();
            approvalPublished = true;
          },
          associated ? f.source : undefined,
        ),
      ).rejects.toThrow();
      expect(approvalPublished).toBe(false);
    });
  },
);
