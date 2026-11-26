import { createHash } from "node:crypto";
import {
  chmod,
  chown,
  link,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  ConditionalWriteConflict,
  replaceConditionalFile,
} from "./WorkspaceFileSystem.write.conditional.ts";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const roots: string[] = [];

async function workspace(contents = "old"): Promise<{ root: string; file: string }> {
  const root = await mkdtemp(join(tmpdir(), "bigbud-conditional-write-"));
  roots.push(root);
  const file = join(root, "file.txt");
  await writeFile(file, contents);
  return { root, file };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("replaceConditionalFile", () => {
  it("replaces atomically, keeps the mode and reports the hash of the written bytes", async () => {
    const { root, file } = await workspace();
    await chmod(file, 0o640);
    const before = await stat(file);
    const result = await replaceConditionalFile(root, file, "new", sha256("old"));
    expect(result).toEqual({ resultSha256: sha256("new"), writeMode: "atomic" });
    expect(await readFile(file, "utf8")).toBe("new");
    const after = await stat(file);
    expect(after.mode & 0o777).toBe(0o640);
    expect(after.ino).not.toBe(before.ino);
    expect((await readdir(root)).toSorted()).toEqual(["file.txt"]);
  });

  it("refuses with the disk hash when the file changed, writing nothing", async () => {
    const { root, file } = await workspace("theirs");
    const failure = await replaceConditionalFile(root, file, "mine", sha256("old")).catch(
      (cause: unknown) => cause,
    );
    expect(failure).toBeInstanceOf(ConditionalWriteConflict);
    expect((failure as ConditionalWriteConflict).actualSha256).toBe(sha256("theirs"));
    expect(await readFile(file, "utf8")).toBe("theirs");
    expect(await readdir(root)).toEqual(["file.txt"]);
  });

  it("writes a hard-linked file in place so both names keep the same contents", async () => {
    const { root, file } = await workspace();
    const other = join(root, "other-name.txt");
    await link(file, other);
    const before = await stat(file);
    const result = await replaceConditionalFile(root, file, "new", sha256("old"));
    expect(result.writeMode).toBe("inPlace");
    expect(await readFile(other, "utf8")).toBe("new");
    expect((await stat(file)).ino).toBe(before.ino);
  });

  it("re-checks a hard-linked file through the opened file before writing", async () => {
    const { root, file } = await workspace();
    await link(file, join(root, "other-name.txt"));
    await writeFile(file, "changed after read");
    await expect(replaceConditionalFile(root, file, "new", sha256("old"))).rejects.toBeInstanceOf(
      ConditionalWriteConflict,
    );
    expect(await readFile(file, "utf8")).toBe("changed after read");
  });

  it("preserves a UTF-8 byte order mark carried in the contents", async () => {
    const { root, file } = await workspace("﻿old");
    await replaceConditionalFile(root, file, "﻿new", sha256("﻿old"));
    const bytes = await readFile(file);
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it("reports a file deleted before the save as a conflict with no disk hash", async () => {
    const { root, file } = await workspace();
    await unlink(file);
    const failure = await replaceConditionalFile(root, file, "new", sha256("old")).catch(
      (cause: unknown) => cause,
    );
    expect(failure).toBeInstanceOf(ConditionalWriteConflict);
    expect((failure as ConditionalWriteConflict).actualSha256).toBeUndefined();
    expect(await readdir(root)).toEqual([]);
  });

  it("keeps an owned file atomic and restores its group when only the group differs", async () => {
    const { root, file } = await workspace();
    const group = process.getegid?.();
    if (group === undefined) return;
    await chown(file, process.geteuid!(), group);
    const result = await replaceConditionalFile(root, file, "new", sha256("old"));
    const after = await stat(file);
    expect(after.gid).toBe(group);
    expect(result.writeMode).toBe("atomic");
    expect(await readFile(file, "utf8")).toBe("new");
  });
});
