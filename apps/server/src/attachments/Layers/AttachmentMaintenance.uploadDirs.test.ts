import { existsSync } from "node:fs";
import { link, lstat, mkdir, readdir, rmdir, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { ServerConfig } from "../../startup/config.ts";
import { SUBMISSION_UPLOAD_DIRECTORY_SCAN_LIMIT } from "../attachmentMaintenance.layout.ts";
import { AttachmentMaintenance } from "../Services/AttachmentMaintenance.ts";
import { removeEmptyDirectoryIfOld } from "./AttachmentMaintenance.fs.ts";
import {
  DAY_MS,
  makeAttachmentMaintenanceTestLayer,
} from "./AttachmentMaintenance.test.helpers.ts";

const promise = <A>(run: () => Promise<A>) => Effect.promise(run);
const uploadDirectories = (root: string) =>
  promise(async () =>
    (await readdir(root)).filter((name) => name.startsWith(".submission-upload-")).toSorted(),
  );

it.effect(
  "removes day-old staging directories that are empty or hold only their old staged file",
  () =>
    Effect.gen(function* () {
      const { attachmentsDir: root, stateDir } = yield* ServerConfig;
      const maintenance = yield* AttachmentMaintenance;
      const at = (name: string) => path.join(root, name);
      yield* promise(async () => {
        await mkdir(root, { recursive: true });
        await mkdir(at(".submission-upload-empty1"));
        await mkdir(at(".submission-upload-busy01"));
        await writeFile(path.join(at(".submission-upload-busy01"), "upload"), "bytes");
        await writeFile(path.join(at(".submission-upload-busy01"), "other"), "bytes");
        // A crash after the staged file was linked to its destination, before the cleanup.
        await mkdir(at(".submission-upload-crash1"));
        await writeFile(path.join(at(".submission-upload-crash1"), "upload"), "published bytes");
        await link(path.join(at(".submission-upload-crash1"), "upload"), at("published-upload"));
        // A staged file written recently (by mtime) is left alone.
        await mkdir(at(".submission-upload-fresh1"));
        await writeFile(path.join(at(".submission-upload-fresh1"), "upload"), "bytes");
        const later = new Date(Date.now() + 2 * DAY_MS);
        await utimes(path.join(at(".submission-upload-fresh1"), "upload"), later, later);
        // A symlink in place of the staged file is never followed or removed.
        await mkdir(at(".submission-upload-slink1"));
        await symlink(at("published-upload"), path.join(at(".submission-upload-slink1"), "upload"));
        await writeFile(at(".submission-upload-file01"), "not a directory");
        // An empty directory outside the root, reachable only through a symlink.
        await mkdir(path.join(stateDir, "outside-empty"));
        await symlink(path.join(stateDir, "outside-empty"), at(".submission-upload-link01"));
        await mkdir(at(".submission-upload-bad.name"));
        await mkdir(at("other-empty-directory"));
      });

      // Under a day old (ctime is the real creation time): nothing is removed yet.
      const young = yield* maintenance.runTick({ nowMs: Date.now() + DAY_MS / 2 });
      assert.equal(young.sweep.uploadDirectoriesRemoved, 0);
      assert.isTrue(existsSync(at(".submission-upload-empty1")));

      const old = yield* maintenance.runTick({ nowMs: Date.now() + 2 * DAY_MS });
      assert.equal(old.status, "completed");
      assert.equal(old.sweep.uploadDirectoriesRemoved, 2);
      assert.equal(old.processed, 2);
      assert.equal(old.sweep.failed, 0);
      assert.deepEqual(yield* uploadDirectories(root), [
        ".submission-upload-bad.name",
        ".submission-upload-busy01",
        ".submission-upload-file01",
        ".submission-upload-fresh1",
        ".submission-upload-link01",
        ".submission-upload-slink1",
      ]);
      assert.isTrue(existsSync(path.join(at(".submission-upload-busy01"), "upload")));
      assert.isTrue(existsSync(path.join(at(".submission-upload-fresh1"), "upload")));
      // The published destination keeps its own link to the bytes.
      assert.isTrue(existsSync(at("published-upload")));
      assert.isTrue(
        (yield* promise(() => lstat(at(".submission-upload-link01")))).isSymbolicLink(),
      );
      assert.isTrue(existsSync(path.join(stateDir, "outside-empty")));
      assert.isTrue(existsSync(at("other-empty-directory")));
    }).pipe(Effect.provide(makeAttachmentMaintenanceTestLayer())),
);

it.effect("removes a large leftover set in bounded ticks and reports the rest as backlog", () =>
  Effect.gen(function* () {
    const { attachmentsDir: root } = yield* ServerConfig;
    const maintenance = yield* AttachmentMaintenance;
    const total = SUBMISSION_UPLOAD_DIRECTORY_SCAN_LIMIT + 48;
    yield* promise(async () => {
      await mkdir(root, { recursive: true });
      for (let index = 0; index < total; index += 1) {
        await mkdir(path.join(root, `.submission-upload-${String(index).padStart(6, "0")}`));
      }
    });
    const nowMs = Date.now() + 2 * DAY_MS;

    const first = yield* maintenance.runTick({ nowMs });
    assert.equal(first.sweep.uploadDirectoriesRemoved, SUBMISSION_UPLOAD_DIRECTORY_SCAN_LIMIT);
    assert.equal(first.backlog, total - SUBMISSION_UPLOAD_DIRECTORY_SCAN_LIMIT);
    assert.lengthOf(yield* uploadDirectories(root), total - SUBMISSION_UPLOAD_DIRECTORY_SCAN_LIMIT);

    const second = yield* maintenance.runTick({ nowMs });
    assert.equal(
      second.sweep.uploadDirectoriesRemoved,
      total - SUBMISSION_UPLOAD_DIRECTORY_SCAN_LIMIT,
    );
    assert.equal(second.backlog, 0);
    assert.deepEqual(yield* uploadDirectories(root), []);
  }).pipe(Effect.provide(makeAttachmentMaintenanceTestLayer())),
);

it.effect("leaves a directory that gains a file or becomes a symlink after its checks", () =>
  Effect.gen(function* () {
    const { stateDir } = yield* ServerConfig;
    const nowMs = Date.now() + 2 * DAY_MS;
    const base = path.join(stateDir, "remove-empty");
    const outcomes = yield* promise(async () => {
      for (const name of ["gains-file", "swapped", "target", "untouched"]) {
        await mkdir(path.join(base, name), { recursive: true });
      }
      const afterChecks = {
        // An upload writes its file once the directory has passed the age and type checks.
        gainsFile: () => writeFile(path.join(base, "gains-file", "upload"), "bytes"),
        // The empty directory is swapped for a symlink to another empty directory.
        swapped: async () => {
          await rmdir(path.join(base, "swapped"));
          await symlink(path.join(base, "target"), path.join(base, "swapped"));
        },
      };
      return {
        gainsFile: await removeEmptyDirectoryIfOld(path.join(base, "gains-file"), {
          nowMs,
          minAgeMs: DAY_MS,
          afterCheck: afterChecks.gainsFile,
        }),
        swapped: await removeEmptyDirectoryIfOld(path.join(base, "swapped"), {
          nowMs,
          minAgeMs: DAY_MS,
          afterCheck: afterChecks.swapped,
        }),
        missing: await removeEmptyDirectoryIfOld(path.join(base, "missing"), {
          nowMs,
          minAgeMs: DAY_MS,
        }),
        untouched: await removeEmptyDirectoryIfOld(path.join(base, "untouched"), {
          nowMs,
          minAgeMs: DAY_MS,
        }),
      };
    });
    assert.deepEqual(outcomes, {
      gainsFile: "not-empty",
      swapped: "not-directory",
      missing: "missing",
      untouched: "removed",
    });
    assert.isTrue(existsSync(path.join(base, "gains-file", "upload")));
    // `rmdir` did not follow the symlink: both it and its empty target are still there.
    assert.isTrue((yield* promise(() => lstat(path.join(base, "swapped")))).isSymbolicLink());
    assert.isTrue(existsSync(path.join(base, "target")));
  }).pipe(Effect.provide(makeAttachmentMaintenanceTestLayer())),
);
