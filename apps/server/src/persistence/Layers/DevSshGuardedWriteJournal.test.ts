import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { isDevSshOwnerSelected } from "../../ssh/sshOwnerDevMode.fixture.ts";
import { layer } from "../NodeSqliteClient.ts";
import {
  type DevSshGuardedWriteBinding,
  type DevSshGuardedWriteReceipt,
  initializeDevSshGuardedWriteJournal,
} from "./DevSshGuardedWriteJournal.ts";

vi.mock("../../ssh/sshOwnerDevMode.fixture.ts", () => ({ isDevSshOwnerSelected: vi.fn() }));

const binding: DevSshGuardedWriteBinding = {
  operationId: "op-1",
  profileId: "fixture-profile",
  targetId: "ssh:fixture",
  cwd: "/fixture/project",
  relativePath: "src/file.txt",
  baseSha256: "a".repeat(64),
  attemptedSha256: "b".repeat(64),
  byteSize: 512 * 1_024,
};
const saved = { kind: "saved", resultSha256: binding.attemptedSha256 } as const;
const terminal = { kind: "terminal" } as const;
const unknown = { kind: "unknown" } as const;
let directory: string;
let filename: string;

beforeEach(() => {
  vi.mocked(isDevSshOwnerSelected).mockReturnValue(true);
  directory = mkdtempSync(join(tmpdir(), "bigbud-dev-ssh-write-journal-"));
  filename = join(directory, "dev.sqlite");
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

const withDb = <A, E>(program: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(program.pipe(Effect.provide(layer({ filename }))));

const openJournal = (capacity?: number) =>
  Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
    initializeDevSshGuardedWriteJournal(sql, capacity),
  );

it("does not initialize the schema outside source development", async () => {
  vi.mocked(isDevSshOwnerSelected).mockReturnValue(false);
  await expect(withDb(openJournal())).rejects.toThrow("Source-dev SSH owner required");
  await withDb(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      expect(yield* sql`SELECT name FROM sqlite_master WHERE type = 'table'`).toEqual([]);
    }),
  );
});

it("refuses a same-ID claim or receipt with any changed binding field", () =>
  withDb(
    Effect.gen(function* () {
      const journal = yield* openJournal();
      expect(yield* journal.lookup(binding)).toEqual({ kind: "missing" });
      expect(yield* journal.recordReceipt(binding, saved)).toEqual({ kind: "missing" });
      expect(yield* journal.claim(binding)).toEqual({ kind: "claimed" });
      const changes: ReadonlyArray<Partial<DevSshGuardedWriteBinding>> = [
        { profileId: "another-profile" },
        { targetId: "ssh:other" },
        { cwd: `${binding.cwd}/.` },
        { relativePath: "./src/file.txt" },
        { baseSha256: "c".repeat(64) },
        { attemptedSha256: "c".repeat(64) },
        { byteSize: binding.byteSize - 1 },
      ];
      for (const change of changes) {
        const changed = { ...binding, ...change };
        expect(yield* journal.claim(changed), JSON.stringify(change)).toEqual({
          kind: "bindingMismatch",
        });
        expect(yield* journal.recordReceipt(changed, terminal)).toEqual({
          kind: "bindingMismatch",
        });
      }
      expect(yield* journal.claim(binding)).toEqual({ kind: "existing", receipt: null });
      expect(yield* journal.lookup(binding)).toEqual({ kind: "existing", receipt: null });
    }),
  ));

it.each<DevSshGuardedWriteReceipt>([
  saved,
  { kind: "conflict", currentSha256: "c".repeat(64) },
  { kind: "conflict", currentSha256: null },
  terminal,
  unknown,
])("persists exactly one $kind receipt across reopen", async (receipt) => {
  await withDb(
    Effect.gen(function* () {
      const journal = yield* openJournal();
      expect(yield* journal.claim(binding)).toEqual({ kind: "claimed" });
      expect(yield* journal.recordReceipt(binding, receipt)).toEqual({ kind: "recorded" });
    }),
  );
  await withDb(
    Effect.gen(function* () {
      const journal = yield* openJournal();
      expect(yield* journal.claim(binding)).toEqual({ kind: "existing", receipt });
      expect(yield* journal.recordReceipt(binding, saved)).toEqual({ kind: "existing", receipt });
      expect(yield* journal.lookup(binding)).toEqual({ kind: "existing", receipt });
    }),
  );
});

it("refuses invalid metadata and a saved receipt with an unbound result hash", () =>
  withDb(
    Effect.gen(function* () {
      expect((yield* Effect.flip(openJournal(1025))).message).toBe("Invalid journal capacity");
      const journal = yield* openJournal();
      for (const change of [
        { operationId: " op-1" },
        { relativePath: "file\0.txt" },
        { cwd: "\uD800" },
        { baseSha256: "BAD" },
        { byteSize: binding.byteSize + 1 },
      ]) {
        expect((yield* Effect.flip(journal.claim({ ...binding, ...change }))).message).toBe(
          "Invalid write binding",
        );
      }
      expect(yield* journal.claim(binding)).toEqual({ kind: "claimed" });
      const failure = yield* Effect.flip(
        journal.recordReceipt(binding, { kind: "saved", resultSha256: binding.baseSha256 }),
      );
      expect(failure.message).toBe("Invalid write receipt");
      expect(yield* journal.lookup(binding)).toEqual({ kind: "existing", receipt: null });
    }),
  ));

it("never claims inside a transaction whose outer commit is still pending", () =>
  withDb(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const journal = yield* openJournal();
      const failure = yield* Effect.flip(sql.withTransaction(journal.claim(binding)));
      expect(failure.message).toBe("Journal requires autocommit");
      expect(yield* journal.lookup(binding)).toEqual({ kind: "missing" });
    }),
  ));

it("allows just one claim and one receipt when separate connections contend", async () => {
  await withDb(openJournal(1));
  const claim = (input: DevSshGuardedWriteBinding) =>
    withDb(Effect.flatMap(openJournal(1), (journal) => journal.claim(input)));
  const claims = await Promise.all([claim(binding), claim(binding)]);
  expect(claims.map(({ kind }) => kind).toSorted()).toEqual(["claimed", "existing"]);
  const settle = (receipt: DevSshGuardedWriteReceipt) =>
    withDb(Effect.flatMap(openJournal(1), (journal) => journal.recordReceipt(binding, receipt)));
  const settlements = await Promise.all([settle(terminal), settle(unknown)]);
  expect(settlements.map(({ kind }) => kind).toSorted()).toEqual(["existing", "recorded"]);
});

it("does not overbook the last slot across separate connections", async () => {
  await withDb(openJournal(1));
  const claim = (operationId: string) =>
    withDb(Effect.flatMap(openJournal(1), (journal) => journal.claim({ ...binding, operationId })));
  const claims = await Promise.all([claim("op-1"), claim("op-2")]);
  expect(claims.map(({ kind }) => kind).toSorted()).toEqual(["capacityReached", "claimed"]);
});

it("fails closed at capacity without pruning pending, unknown, or terminal rows", () =>
  withDb(
    Effect.gen(function* () {
      const journal = yield* openJournal(3);
      const pending = binding;
      const unconfirmed = { ...binding, operationId: "op-2" };
      const finished = { ...binding, operationId: "op-3", byteSize: 0 };
      for (const input of [pending, unconfirmed, finished]) {
        expect(yield* journal.claim(input)).toEqual({ kind: "claimed" });
      }
      expect(yield* journal.recordReceipt(unconfirmed, unknown)).toEqual({ kind: "recorded" });
      expect(yield* journal.recordReceipt(finished, terminal)).toEqual({ kind: "recorded" });
      expect(yield* journal.claim({ ...binding, operationId: "op-4" })).toEqual({
        kind: "capacityReached",
      });
      expect(yield* journal.claim(pending)).toEqual({ kind: "existing", receipt: null });
      expect(yield* journal.claim(unconfirmed)).toEqual({ kind: "existing", receipt: unknown });
      expect(yield* journal.claim(finished)).toEqual({ kind: "existing", receipt: terminal });
      expect(yield* journal.recordReceipt(pending, saved)).toEqual({ kind: "recorded" });
    }),
  ));

it("fences an acknowledged claim after the process exits without closing SQLite or recording a receipt", async () => {
  const script = `
    import * as Effect from 'effect/Effect';
    import { SqlClient } from 'effect/unstable/sql/SqlClient';
    import { activateDevSshOwner } from ${JSON.stringify(new URL("../../ssh/sshOwnerDevMode.fixture.ts", import.meta.url).href)};
    import { layer } from ${JSON.stringify(new URL("../NodeSqliteClient.ts", import.meta.url).href)};
    import { initializeDevSshGuardedWriteJournal } from ${JSON.stringify(new URL("./DevSshGuardedWriteJournal.ts", import.meta.url).href)};
    activateDevSshOwner();
    await Effect.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* sql\x60PRAGMA journal_mode = WAL\x60;
      const journal = yield* initializeDevSshGuardedWriteJournal(sql);
      const claim = yield* journal.claim(${JSON.stringify(binding)});
      process.exit(claim.kind === 'claimed' ? 17 : 18);
    }).pipe(Effect.provide(layer({ filename: process.argv[1] }))));
  `;
  const child = spawnSync(
    process.execPath,
    ["--experimental-transform-types", "--input-type=module", "--eval", script, filename],
    {
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, BIGBUD_SQLITE_WORKER: "0" },
    },
  );
  expect(child.status, child.stderr).toBe(17);
  await withDb(
    Effect.gen(function* () {
      const journal = yield* openJournal();
      expect(yield* journal.claim(binding)).toEqual({ kind: "existing", receipt: null });
      expect(yield* journal.claim({ ...binding, attemptedSha256: "c".repeat(64) })).toEqual({
        kind: "bindingMismatch",
      });
    }),
  );
});
