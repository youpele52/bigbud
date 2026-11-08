import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { allocateManagedWorkspace, copyWorkspaceFiles } from "./ProjectWorkspace.files.ts";
import { recordedWorktreePathsOverlap } from "../deletion/Layers/ThreadDeletion.worktreePaths.ts";

const roots: string[] = [];
async function fixture() {
  const root = await fs.mkdtemp(path.join(tmpdir(), "bigbud-workspace-files-"));
  roots.push(root);
  const source = path.join(root, "source");
  const destination = path.join(root, "destination");
  await fs.mkdir(source);
  await fs.mkdir(destination);
  return { root, source, destination };
}
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("managed project workspace files", () => {
  it("allocates by ID, safely encodes traversal, and preserves files on retry", async () => {
    const { root } = await fixture();
    const allocated = await allocateManagedWorkspace(root, "../project/title");
    expect(path.relative(await fs.realpath(root), allocated).startsWith("..")).toBe(false);
    await fs.writeFile(path.join(allocated, "keep.txt"), "keep");
    expect(await allocateManagedWorkspace(root, "../project/title")).toBe(allocated);
    expect(await fs.readFile(path.join(allocated, "keep.txt"), "utf8")).toBe("keep");
    expect(await fs.readdir(allocated)).toEqual(["keep.txt"]);
    expect(await allocateManagedWorkspace(root, "other-project")).not.toBe(allocated);
  });
  it("transfers nested files and links while retaining the original recovery copy", async () => {
    const { source, destination } = await fixture();
    await fs.mkdir(path.join(source, "nested"));
    await fs.writeFile(path.join(source, "nested", "file.txt"), "data");
    await fs.symlink("nested/file.txt", path.join(source, "link"));
    await copyWorkspaceFiles(source, destination);
    expect(await fs.readFile(path.join(destination, "nested", "file.txt"), "utf8")).toBe("data");
    expect(await fs.readlink(path.join(destination, "link"))).toBe("nested/file.txt");
    expect(await fs.readFile(path.join(source, "nested", "file.txt"), "utf8")).toBe("data");
  });
  it("refuses collisions and retries rather than merging or overwriting", async () => {
    const { source, destination } = await fixture();
    await fs.writeFile(path.join(source, "file.txt"), "original");
    await fs.writeFile(path.join(destination, "file.txt"), "user data");
    await expect(copyWorkspaceFiles(source, destination)).rejects.toThrow(
      "destination must be empty",
    );
    expect(await fs.readFile(path.join(destination, "file.txt"), "utf8")).toBe("user data");
    expect(await fs.readFile(path.join(source, "file.txt"), "utf8")).toBe("original");
  });
  it("refuses aliases and overlapping folders", async () => {
    const { root, source } = await fixture();
    const nested = path.join(source, "nested");
    await fs.mkdir(nested);
    await expect(copyWorkspaceFiles(source, nested)).rejects.toThrow("outside");
    await expect(copyWorkspaceFiles(source, root)).rejects.toThrow("outside");
    await expect(copyWorkspaceFiles(source, source)).rejects.toThrow("outside");
  });
  it.each([
    ["C:\\managed\\project", "D:\\projects\\destination", false],
    ["C:\\managed\\project", "C:\\managed\\project-copy", false],
    ["C:\\managed\\project", "c:\\MANAGED\\PROJECT\\child", true],
    ["C:\\managed\\project", "C:\\managed", true],
    ["C:\\", "C:\\managed\\project", true],
    ["C:\\managed\\project", "c:\\", true],
    ["C:\\", "D:\\managed\\project", false],
  ] as const)(
    "classifies Windows transfer overlap for %s and %s",
    (source, destination, overlaps) => {
      expect(recordedWorktreePathsOverlap(source, destination, path.win32)).toBe(overlaps);
    },
  );
  it("recognizes the POSIX root as overlapping every absolute descendant", () => {
    expect(recordedWorktreePathsOverlap("/", "/tmp/project", path.posix)).toBe(true);
    expect(recordedWorktreePathsOverlap("/tmp/project", "/", path.posix)).toBe(true);
    expect(recordedWorktreePathsOverlap("/tmp/project", "/tmp/project-other", path.posix)).toBe(
      false,
    );
  });
  it("preserves source after destination errors", async () => {
    const { source, destination } = await fixture();
    await fs.writeFile(path.join(source, "file.txt"), "original");
    await fs.rmdir(destination);
    await expect(copyWorkspaceFiles(source, destination)).rejects.toThrow();
    expect(await fs.readFile(path.join(source, "file.txt"), "utf8")).toBe("original");
  });
});
