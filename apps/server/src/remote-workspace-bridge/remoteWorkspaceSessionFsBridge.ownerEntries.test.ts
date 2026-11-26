import { describe, expect, it, vi } from "vitest";

import { makeSessionFsOwnerEntries } from "./remoteWorkspaceSessionFsBridge.ownerEntries.ts";

type Kind = "missing" | "file" | "directory" | "other";

function owner(tree: Record<string, Kind>, children: Record<string, string[]> = {}) {
  const methods = {
    listProofWorkspaceDirectory: vi.fn(async ({ relativeDir }: { relativeDir: string }) => ({
      entries: (children[relativeDir] ?? []).map((name) => ({
        name,
        directory: tree[relativeDir ? `${relativeDir}/${name}` : name] === "directory",
      })),
      truncated: false,
    })),
    workspaceEntryInfo: vi.fn(async ({ relativePath }: { relativePath: string }) => ({
      kind: tree[relativePath] ?? ("missing" as Kind),
      size: 5,
      mtimeMs: 1_000,
      birthtimeMs: 500,
    })),
    deleteProofWorkspaceEntry: vi.fn(async ({ relativePath }: { relativePath: string }) => {
      if (!tree[relativePath] || tree[relativePath] === "missing") return "notFound" as const;
      tree[relativePath] = "missing";
      return "deleted" as const;
    }),
    renameWorkspaceEntry: vi.fn(
      async ({
        relativePath,
        destinationPath,
        replace,
      }: {
        relativePath: string;
        destinationPath: string;
        replace?: boolean;
      }) => {
        if ((tree[relativePath] ?? "missing") === "missing") return "notFound" as const;
        const destination = tree[destinationPath] ?? "missing";
        if (
          destination !== "missing" &&
          !(replace && destination === "file" && tree[relativePath] === "file")
        )
          return "alreadyExists" as const;
        tree[destinationPath] = tree[relativePath]!;
        tree[relativePath] = "missing";
        return "done" as const;
      },
    ),
    appendWorkspaceFile: vi.fn(async () => "done" as const),
  };
  const entries = makeSessionFsOwnerEntries({
    targetId: "ssh:box",
    workspaceRoot: "/srv",
    withOwner: (_id, use) => use(methods),
  });
  return { entries, methods, tree };
}

describe("session-FS entry operations over typed owner verbs", () => {
  it("lists, stats and checks existence through the owner", async () => {
    const { entries } = owner({ "": "directory", a: "file", d: "directory" }, { "": ["a", "d"] });
    expect(await entries.readdir("")).toEqual(["a", "d"]);
    expect(await entries.readdirWithTypes("")).toEqual([
      { name: "a", type: "file" },
      { name: "d", type: "directory" },
    ]);
    expect(await entries.exists("a")).toBe(true);
    expect(await entries.exists("zz")).toBe(false);
    expect(await entries.stat("a", "/srv/a")).toMatchObject({ isFile: true, size: 5 });
    await expect(entries.stat("zz", "/srv/zz")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes by the owner-reported kind and honours recursive and force", async () => {
    const { entries, methods } = owner({ a: "file", d: "directory", "d/x": "file" }, { d: ["x"] });
    await expect(entries.rm("d", false, false, "/srv/d")).rejects.toMatchObject({
      code: "ENOTEMPTY",
    });
    await entries.rm("d", true, false, "/srv/d");
    expect(methods.deleteProofWorkspaceEntry).toHaveBeenLastCalledWith(
      expect.objectContaining({ relativePath: "d", expectedDirectory: true }),
    );
    await entries.rm("a", false, false, "/srv/a");
    await entries.rm("a", false, true, "/srv/a");
    await expect(entries.rm("a", false, false, "/srv/a")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("renames, replaces a file destination like POSIX, and refuses a directory clash", async () => {
    const { entries, tree, methods } = owner({
      a: "file",
      b: "file",
      d: "directory",
      e: "directory",
    });
    await entries.rename("a", "b", "/srv/a");
    expect(tree).toMatchObject({ a: "missing", b: "file" });
    // One atomic owner rename; no delete step.
    expect(methods.renameWorkspaceEntry).toHaveBeenCalledOnce();
    expect(methods.deleteProofWorkspaceEntry).not.toHaveBeenCalled();
    await expect(entries.rename("d", "e", "/srv/d")).rejects.toMatchObject({ code: "EEXIST" });
    await expect(entries.rename("nope", "z", "/srv/nope")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("appends in 48 KiB chunks and creates a missing file", async () => {
    const { entries, methods } = owner({ log: "file" });
    await entries.appendFile("log", "x".repeat(100 * 1024), async () => undefined);
    expect(methods.appendWorkspaceFile).toHaveBeenCalledTimes(3);
    const create = vi.fn(async () => undefined);
    await entries.appendFile("new", "hi", create);
    expect(create).toHaveBeenCalledOnce();
  });
});
