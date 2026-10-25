import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { readV2WindowsDirectoryIdentity } from "./SharedService.windows.identity.ts";
import { ownV2WindowsFixture } from "./SharedService.windows.fixture.mjs";
import { v2WindowsInspector } from "./SharedService.windows.ts";

it.skipIf(process.platform !== "win32")(
  "inspects exact directory identity and rejects foreign mutation, files and junctions",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "native-directory-"));
    try {
      await ownV2WindowsFixture(root);
      const directory = path.join(root, "owned");
      await mkdir(directory);
      await ownV2WindowsFixture(directory);
      const first = await readV2WindowsDirectoryIdentity(directory);
      expect(await readV2WindowsDirectoryIdentity(directory)).toBe(first);
      const moved = path.join(root, "moved");
      await rename(directory, moved);
      await mkdir(directory);
      await ownV2WindowsFixture(directory);
      expect(await readV2WindowsDirectoryIdentity(directory)).not.toBe(first);
      expect(await readV2WindowsDirectoryIdentity(moved)).toBe(first);
      const link = path.join(root, "junction");
      await symlink(directory, link, "junction");
      await expect(readV2WindowsDirectoryIdentity(link)).rejects.toThrow("rejected");
      const file = path.join(root, "file");
      await writeFile(file, "fixture");
      await expect(readV2WindowsDirectoryIdentity(file)).rejects.toThrow("rejected");
      execFileSync("icacls.exe", [directory, "/grant", "*S-1-1-0:(M)"], { stdio: "ignore" });
      await expect(readV2WindowsDirectoryIdentity(directory)).rejects.toThrow("rejected");
    } finally {
      v2WindowsInspector.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
