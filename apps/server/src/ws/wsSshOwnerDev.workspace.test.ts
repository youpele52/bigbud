import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { describe, expect, it, vi } from "vitest";

import { PickerProofOwnerError, type PickerProofOwner } from "../ssh/sshOwnerPickerProof.client.ts";
import type { WorkspaceRuntimeShape } from "../workspace-runtime/Services/WorkspaceRuntime.ts";
import { WorkspacePathsLive } from "../workspace/Layers/WorkspacePaths.ts";
import type { SelectedGuardedWorkspaceWrite } from "./wsSshOwnerDev.workspace.guarded.ts";
import { withWsSshOwnerDevWorkspace } from "./wsSshOwnerDev.workspace.ts";

const executionTargetId = "ssh:host=rust-ssh-owner-dev&auth=ssh-key&transport=direct-ssh";
const cwd = "/fixture/picker's folders; literal";
const fixture = { executionTargetId, cwd };
const pathsLayer = WorkspacePathsLive.pipe(Layer.provide(NodeServices.layer));

async function setup(guardedWrite?: SelectedGuardedWorkspaceWrite) {
  const fallback = vi.fn(() => Effect.die("unexpected default workspace operation"));
  const listDirectory = vi.fn<PickerProofOwner["listProofWorkspaceDirectory"]>();
  const readFile = vi.fn<PickerProofOwner["readProofWorkspaceFile"]>();
  const snapshotDirectory = vi.fn<PickerProofOwner["snapshotProofWorkspaceDirectory"]>();
  const index = vi.fn<PickerProofOwner["indexProofWorkspace"]>();
  const search = vi.fn<PickerProofOwner["searchProofWorkspaceContents"]>();
  const write = vi.fn<PickerProofOwner["writeProofWorkspaceFile"]>();
  const owner = {
    writeProofWorkspaceFile: write,
    indexProofWorkspace: index,
    searchProofWorkspaceContents: search,
    listProofWorkspaceDirectory: listDirectory,
    readProofWorkspaceFile: readFile,
    snapshotProofWorkspaceDirectory: snapshotDirectory,
  } as unknown as PickerProofOwner;
  const acquireOwner = vi.fn(async (targetId: string) => {
    expect(targetId).toBe(executionTargetId);
    return owner;
  });
  const original: WorkspaceRuntimeShape = {
    files: {
      listDirectory: fallback,
      readFilePreview: fallback,
      readFileRange: fallback,
      writeFile: fallback,
    },
    search: { searchEntries: fallback, searchFileContents: fallback },
    watch: { watchDirectory: fallback },
  };
  const runtime = await Effect.runPromise(
    withWsSshOwnerDevWorkspace(original, {
      targetId: executionTargetId,
      workspaceRoot: cwd,
      ...(guardedWrite ? { guardedWrite } : {}),
      withOwner: async (targetId, use) => use(await acquireOwner(targetId)),
    }).pipe(Effect.provide(pathsLayer)),
  );
  return {
    runtime,
    withOwner: acquireOwner,
    fallback,
    listDirectory,
    readFile,
    snapshotDirectory,
    index,
    search,
    write,
  };
}

const failure = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.flip(effect));

describe("selected normal-dev SSH workspace", () => {
  it("refuses an incomplete directory listing instead of reporting a complete tree", async () => {
    const { runtime, listDirectory, fallback } = await setup();
    listDirectory.mockResolvedValue({
      entries: [{ name: "partial", directory: false }],
      truncated: true,
    });
    expect(await failure(runtime.files.listDirectory(fixture))).toMatchObject({
      _tag: "WorkspaceEntriesError",
      detail: expect.stringContaining("incomplete"),
    });
    expect(fallback).not.toHaveBeenCalled();
  });
  it("lists root and nested children with normal tree ordering, filtering and parent paths", async () => {
    const { runtime, fallback, listDirectory, withOwner } = await setup();
    listDirectory
      .mockResolvedValueOnce({
        entries: [
          { name: "a.txt", directory: false },
          { name: "Z repo", directory: true },
          { name: "alpha", directory: true },
          { name: ".git", directory: true },
          { name: "path/alias", directory: false },
        ],
        truncated: false,
      })
      .mockResolvedValueOnce({
        entries: [{ name: "a file.txt", directory: false }],
        truncated: false,
      });
    await expect(Effect.runPromise(runtime.files.listDirectory(fixture))).resolves.toEqual({
      entries: [
        { path: "alpha", kind: "directory" },
        { path: "Z repo", kind: "directory" },
        { path: "a.txt", kind: "file" },
      ],
    });
    await expect(
      Effect.runPromise(runtime.files.listDirectory({ ...fixture, relativePath: "./Z repo/" })),
    ).resolves.toEqual({
      entries: [{ path: "Z repo/a file.txt", kind: "file", parentPath: "Z repo" }],
    });
    expect(listDirectory).toHaveBeenNthCalledWith(1, {
      executionTargetId,
      workspaceRoot: cwd,
      relativeDir: "",
    });
    expect(listDirectory).toHaveBeenNthCalledWith(2, {
      executionTargetId,
      workspaceRoot: cwd,
      relativeDir: "Z repo",
    });
    expect(withOwner).toHaveBeenCalledTimes(2);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("returns decoded preview data and clamps ranges before using the same owner", async () => {
    const { runtime, readFile, fallback } = await setup();
    readFile
      .mockResolvedValueOnce({ data: Buffer.from("héllo\n"), sizeBytes: 7, truncated: false })
      .mockResolvedValueOnce({ data: Uint8Array.of(0xff), sizeBytes: 10, truncated: true });
    const input = { ...fixture, relativePath: "./Z repo/notes.txt" };
    await expect(Effect.runPromise(runtime.files.readFilePreview(input))).resolves.toEqual({
      relativePath: "Z repo/notes.txt",
      contents: "héllo\n",
      sizeBytes: 7,
      truncated: false,
    });
    await expect(
      Effect.runPromise(
        runtime.files.readFileRange({ ...input, offset: 2.8, maxBytes: 1_000_000 }),
      ),
    ).resolves.toEqual({
      relativePath: "Z repo/notes.txt",
      bytes: Uint8Array.of(0xff),
      sizeBytes: 10,
      truncated: true,
    });
    const wireInput = { executionTargetId, workspaceRoot: cwd, relativePath: "Z repo/notes.txt" };
    expect(readFile).toHaveBeenNthCalledWith(1, { ...wireInput, kind: "preview" });
    expect(readFile).toHaveBeenNthCalledWith(2, {
      ...wireInput,
      kind: "range",
      offset: 2,
      maxBytes: 524_288,
    });
    expect(fallback).not.toHaveBeenCalled();
  });

  it("refuses other SSH targets, nonexact roots and invalid paths before owner acquisition", async () => {
    const { runtime, withOwner, fallback } = await setup();
    for (const input of [
      { ...fixture, executionTargetId: "ssh:host=another" },
      { ...fixture, cwd: `${cwd}/.` },
    ]) {
      expect(await failure(runtime.files.listDirectory(input))).toMatchObject({
        _tag: "WorkspaceEntriesError",
        detail: expect.stringContaining("exact development fixture"),
      });
      expect(
        await failure(runtime.files.readFilePreview({ ...input, relativePath: "notes.txt" })),
      ).toMatchObject({
        _tag: "WorkspaceFileSystemError",
        retryable: false,
      });
    }
    for (const relativePath of ["../outside", "/outside", "\\outside", "nul\0byte"]) {
      expect(
        await failure(runtime.files.listDirectory({ ...fixture, relativePath })),
      ).toMatchObject({
        _tag: "WorkspaceEntriesError",
        operation: "workspaceEntries.remoteDirectoryPath",
      });
      expect(
        await failure(runtime.files.readFilePreview({ ...fixture, relativePath })),
      ).toMatchObject({
        _tag: "WorkspacePathOutsideRootError",
        relativePath,
      });
    }
    expect(withOwner).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
  });

  it("surfaces owner failures without trying the default workspace backend", async () => {
    const { runtime, withOwner, fallback } = await setup();
    const cause = new Error("SSH owner unavailable");
    withOwner.mockRejectedValue(cause);
    expect(await failure(runtime.files.listDirectory(fixture))).toMatchObject({
      _tag: "WorkspaceEntriesError",
      detail: cause.message,
      cause,
    });
    expect(
      await failure(runtime.files.readFilePreview({ ...fixture, relativePath: "note.txt" })),
    ).toMatchObject({
      _tag: "WorkspaceFileSystemError",
      detail: cause.message,
      cause,
    });
    expect(fallback).not.toHaveBeenCalled();
  });

  it("blocks unsupported and outside-scope writes without starting an owner", async () => {
    const { runtime, withOwner, fallback } = await setup();
    const request = { ...fixture, relativePath: "note.txt", contents: "no" };
    for (const invalid of [
      { ...request, createOnly: true },
      { ...request, expectedSha256: "0".repeat(64) },
      { ...request, contents: "a".repeat(512 * 1024 + 1) },
      { ...request, cwd: `${cwd}/other` },
      { ...request, executionTargetId: "ssh:other" },
    ]) {
      expect(await failure(runtime.files.writeFile(invalid))).toMatchObject({
        retryable: false,
        writeDisposition: "not-dispatched",
      });
    }
    await failure(runtime.files.writeFile({ ...request, relativePath: "../outside" }));
    expect(
      await failure(
        runtime.search.searchEntries({ ...fixture, cwd: `${cwd}/other`, query: "note", limit: 1 }),
      ),
    ).toMatchObject({ detail: expect.stringContaining("exact") });
    expect(
      await failure(
        runtime.search.searchFileContents({
          ...fixture,
          executionTargetId: "ssh:other",
          query: "note",
          limit: 1,
        }),
      ),
    ).toMatchObject({ detail: expect.stringContaining("exact") });
    expect(withOwner).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
  });

  it("advertises and dispatches guarded saves only with a qualified exact binding", async () => {
    const base = "a".repeat(64);
    const resultSha256 = "b".repeat(64);
    const apply = vi.fn<SelectedGuardedWorkspaceWrite["apply"]>();
    const { runtime, readFile, write, fallback } = await setup({ apply });
    const input = { ...fixture, relativePath: "note.txt" };
    readFile.mockResolvedValue({
      data: Uint8Array.of(65),
      sizeBytes: 1,
      truncated: false,
      sha256: base,
    });
    expect(await Effect.runPromise(runtime.files.readFilePreview(input))).toMatchObject({
      sha256: base,
      edit: { mode: "guarded", maxBytes: 512 * 1024 },
    });
    const save = { ...input, operationId: "save-once", contents: "B", expectedSha256: base };
    apply
      .mockResolvedValueOnce({ kind: "saved", resultSha256 })
      .mockResolvedValueOnce({ kind: "conflict", currentSha256: resultSha256 });
    expect(await Effect.runPromise(runtime.files.writeFile(save))).toEqual({
      relativePath: "note.txt",
      resultSha256,
    });
    expect(
      await failure(runtime.files.writeFile({ ...save, operationId: "conflict" })),
    ).toMatchObject({
      writeDisposition: "terminal",
      conflict: true,
      currentSha256: resultSha256,
    });
    await failure(runtime.files.writeFile({ ...save, cwd: `${cwd}/wrong` }));
    await failure(runtime.files.writeFile({ ...save, relativePath: "../outside" }));
    expect(apply).toHaveBeenCalledTimes(2);
    expect(write).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
  });

  it("dispatches one bounded overwrite and preserves terminal versus unknown failures", async () => {
    const { runtime, write, fallback } = await setup();
    const contents = "é".repeat(24 * 1024);
    const request = { ...fixture, relativePath: "./docs/note.txt", contents };
    write
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new PickerProofOwnerError("workspaceWriteFailed"))
      .mockRejectedValueOnce(new PickerProofOwnerError("outcomeUnknown"));
    await expect(Effect.runPromise(runtime.files.writeFile(request))).resolves.toEqual({
      relativePath: "docs/note.txt",
    });
    expect(write).toHaveBeenCalledExactlyOnceWith({
      executionTargetId,
      workspaceRoot: cwd,
      relativePath: "docs/note.txt",
      contents: new TextEncoder().encode(contents),
    });
    for (const disposition of ["terminal", "unknown"] as const) {
      expect(await failure(runtime.files.writeFile(request))).toMatchObject({
        writeDisposition: disposition,
        retryable: false,
      });
    }
    expect(write).toHaveBeenCalledTimes(3);
    const large = "x".repeat(512 * 1024);
    const largeWrite = { ...fixture, relativePath: "docs/large.txt", contents: large };
    await expect(Effect.runPromise(runtime.files.writeFile(largeWrite))).resolves.toEqual({
      relativePath: "docs/large.txt",
    });
    expect(write.mock.lastCall?.[0].contents).toEqual(new TextEncoder().encode(large));
    expect(
      await failure(runtime.files.writeFile({ ...largeWrite, contents: `${large}y` })),
    ).toMatchObject({
      writeDisposition: "not-dispatched",
    });
    expect(fallback).not.toHaveBeenCalled();
  });

  it("ranks owner-indexed names and preserves bounded native content results without fallback", async () => {
    const { runtime, index, search, fallback } = await setup();
    index.mockResolvedValue({
      entries: [
        { path: "docs/note.txt", directory: false },
        { path: "../note.txt", directory: false },
        { path: ".git/note.txt", directory: false },
      ],
      truncated: true,
    });
    const match = { path: "docs/note.txt", line: 1, column: 1, lineText: "literal. note" };
    search.mockResolvedValue({ matches: [match, { ...match, line: 2 }], truncated: false });
    await expect(
      Effect.runPromise(runtime.search.searchEntries({ ...fixture, query: "note", limit: 3 })),
    ).resolves.toMatchObject({
      entries: [{ path: "docs/note.txt", parentPath: "docs", kind: "file" }],
      truncated: true,
    });
    await expect(
      Effect.runPromise(
        runtime.search.searchFileContents({ ...fixture, query: "literal.", limit: 1 }),
      ),
    ).resolves.toMatchObject({
      matches: [match],
      truncated: true,
    });
    expect(index).toHaveBeenCalledExactlyOnceWith({ executionTargetId, workspaceRoot: cwd });
    expect(search).toHaveBeenCalledExactlyOnceWith({
      executionTargetId,
      workspaceRoot: cwd,
      query: "literal.",
      limit: 1,
    });
    expect(fallback).not.toHaveBeenCalled();
  });

  it("watches the exact fixture through the owner and rejects other routes before acquisition", async () => {
    const { runtime, snapshotDirectory, withOwner, fallback } = await setup();
    snapshotDirectory.mockResolvedValue("snapshot");
    const watch = await Effect.runPromise(
      runtime.watch.watchDirectory({ ...fixture, relativePath: "./src" }),
    );
    const event = await Effect.runPromise(Stream.runHead(watch));
    expect(event).toMatchObject({
      _tag: "Some",
      value: { type: "directoryChanged", relativePath: "src", generation: 1 },
    });
    expect(snapshotDirectory).toHaveBeenCalledWith(
      { executionTargetId, workspaceRoot: cwd, relativeDir: "src" },
      expect.any(AbortSignal),
    );
    withOwner.mockClear();
    expect(
      await failure(runtime.watch.watchDirectory({ ...fixture, cwd: `${cwd}/.` })),
    ).toMatchObject({ retryable: false });
    await failure(runtime.watch.watchDirectory({ ...fixture, relativePath: "../outside" }));
    expect(withOwner).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
  });

  it("continues to use the default runtime for local and non-SSH targets", async () => {
    const { runtime, withOwner, fallback } = await setup();
    const local = { cwd: "/local" };
    const peer = { cwd: "/peer", executionTargetId: "peer:test", relativePath: "notes.txt" };
    const originalEffect = Effect.die("default effect");
    fallback.mockReturnValue(originalEffect);
    expect(runtime.files.readFilePreview(peer)).toBe(originalEffect);
    expect(runtime.watch.watchDirectory(local)).toBe(originalEffect);
    await Effect.runPromiseExit(runtime.files.listDirectory(local));
    expect(fallback.mock.calls).toEqual([[peer], [local], [local]]);
    expect(withOwner).not.toHaveBeenCalled();
  });
});
