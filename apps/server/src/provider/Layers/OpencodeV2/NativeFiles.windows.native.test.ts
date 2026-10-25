import { execFileSync } from "node:child_process";
import { mkdtemp, rm, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { expect, it } from "vitest";
import { ownV2WindowsFixture } from "./SharedService.windows.fixture.mjs";
import {
  windowsDirectory,
  windowsMkdir,
  windowsRead,
  windowsCreate,
  windowsPublish,
  windowsRemove,
  windowsList,
  v2WindowsFiles,
} from "./NativeFiles.windows.ts";
import { withV2WindowsReadLease } from "./NativeFiles.windows.lease.ts";

it.skipIf(process.platform !== "win32")(
  "native exclusive/conditional publication preserves collisions, identities and locked ancestors",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "native-files-"));
    try {
      await ownV2WindowsFixture(root);
      const directory = path.join(root, "owned");
      const parent = await windowsMkdir(root, "owned", () => {});
      const target = path.join(directory, "record"),
        staging = path.join(directory, "pending");
      const first = await windowsCreate(target, "first", () => {}, parent);
      await expect(windowsCreate(target, "foreign", () => {}, parent)).rejects.toMatchObject({
        code: "EEXIST",
      });
      const next = await windowsCreate(staging, "next", () => {}, parent);
      await expect(
        windowsPublish(staging, target, next, { ...first, hash: "0".repeat(64) }, parent, () => {}),
      ).rejects.toMatchObject({ code: "ESTALE" });
      expect((await windowsRead(target, true)).content).toBe("first");
      await expect(
        windowsPublish(
          staging,
          target,
          { ...next, identity: { ...next.identity, ino: "0".repeat(32) } },
          first,
          parent,
          () => {},
        ),
      ).rejects.toMatchObject({ code: "ESTALE" });
      await windowsPublish(staging, target, next, first, parent, () => {});
      expect(await windowsRead(target, true)).toEqual(next);
      expect(await windowsList(directory)).toEqual(["record"]);
      await withV2WindowsReadLease(target, async (lease) => {
        expect(lease.hash).toBe(next.hash);
        await expect(rename(directory, path.join(root, "moved"))).rejects.toThrow();
        await expect(writeFile(target, "raced")).rejects.toThrow();
        await lease.verify();
        lease.assertCurrent();
      });
      const link = path.join(root, "junction");
      await symlink(directory, link, "junction");
      await expect(windowsCreate(path.join(link, "foreign"), "x", () => {})).rejects.toThrow();
      await rename(directory, path.join(root, "moved"));
      await windowsMkdir(root, "owned", () => {});
      await expect(
        windowsCreate(path.join(directory, "foreign"), "x", () => {}, parent),
      ).rejects.toMatchObject({ code: "ESTALE" });
      const moved = path.join(root, "moved", "record");
      await expect(windowsRemove(moved, first, () => {})).rejects.toMatchObject({ code: "ESTALE" });
      await windowsRemove(moved, next, () => {});
      expect(await windowsList(path.dirname(moved))).toEqual([]);
    } finally {
      v2WindowsFiles.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform !== "win32")(
  "native public-config reads reject foreign data writes, and private reads reject foreign read grants",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "native-acl-"));
    try {
      await ownV2WindowsFixture(root);
      const file = path.join(root, "config.json");
      await windowsCreate(file, "{}", () => {});
      execFileSync("icacls.exe", [file, "/grant", "*S-1-1-0:(R)"], { stdio: "ignore" });
      expect((await windowsRead(file, false)).content).toBe("{}");
      await expect(windowsRead(file, true)).rejects.toThrow();
      execFileSync("icacls.exe", [file, "/grant", "*S-1-1-0:(W)"], { stdio: "ignore" });
      await expect(windowsRead(file, false)).rejects.toThrow();
      execFileSync("icacls.exe", [root, "/grant", "*S-1-1-0:(M)"], { stdio: "ignore" });
      await expect(windowsDirectory(root, false)).rejects.toThrow();
    } finally {
      v2WindowsFiles.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
