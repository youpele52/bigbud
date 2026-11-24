import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Effect, Exit } from "effect";

import { makeWorkspacePaths } from "../../workspace/Layers/WorkspacePaths.ts";
import type { WorkspaceTrash } from "../../workspace/Layers/WorkspaceTrash.ts";
import {
  WORKSPACE_ENTRY_ALREADY_EXISTS,
  WORKSPACE_ENTRY_NOT_FOUND,
} from "../Services/WorkspaceMutations.ts";
import { makeLocalWorkspaceMutations } from "./WorkspaceMutations.local.ts";

const noTrash: WorkspaceTrash = {
  available: false,
  moveToTrash: () => Promise.reject(new Error("unused")),
};

let base: string;
let cwd: string;
const invalidate = vi.fn(() => Effect.void);

async function make(trash: WorkspaceTrash = noTrash) {
  const workspacePaths = await Effect.runPromise(
    makeWorkspacePaths.pipe(Effect.provide(NodeServices.layer)),
  );
  return makeLocalWorkspaceMutations({ workspacePaths, workspaceEntries: { invalidate }, trash });
}

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

async function failure<A, E>(effect: Effect.Effect<A, E>): Promise<E> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) throw new Error("expected failure");
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail");
  if (!error || error._tag !== "Fail") throw new Error("expected a typed failure");
  return error.error;
}

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "bigbud-entry-mutations-")));
  cwd = join(base, "ws");
  await mkdir(join(cwd, "src/nested"), { recursive: true });
  await writeFile(join(cwd, "README.md"), "readme");
  await writeFile(join(cwd, "src/nested/a.txt"), "a");
  await mkdir(join(base, "outside"));
  await writeFile(join(base, "outside/keep.txt"), "keep");
  invalidate.mockClear();
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("local workspace mutations", () => {
  it("reports actions: allowed locally, read only for Direct SSH, permanent without Trash", async () => {
    const mutations = await make();
    expect(await Effect.runPromise(mutations.entryActions({ cwd }))).toEqual({
      createFile: { allowed: true },
      createFolder: { allowed: true },
      delete: { allowed: true, permanent: true },
    });
    const trashed = await make({ available: true, moveToTrash: async () => {} });
    expect((await Effect.runPromise(trashed.entryActions({ cwd }))).delete.permanent).toBe(false);
    const ssh = await Effect.runPromise(
      mutations.entryActions({ cwd, executionTargetId: "ssh:host=example&transport=direct-ssh" }),
    );
    expect(ssh.createFolder).toEqual({ allowed: false, reason: "directSshPendingOwner" });
    expect(ssh.delete.allowed).toBe(false);
  });

  it("creates one folder and refuses an existing entry or a missing parent", async () => {
    const mutations = await make();
    await Effect.runPromise(mutations.createDirectory({ cwd, relativePath: "src/new" }));
    expect((await lstat(join(cwd, "src/new"))).isDirectory()).toBe(true);
    expect(invalidate).toHaveBeenCalledWith(cwd);

    const existing = await failure(mutations.createDirectory({ cwd, relativePath: "README.md" }));
    expect(existing).toMatchObject({ detail: WORKSPACE_ENTRY_ALREADY_EXISTS });
    expect(await readFile(join(cwd, "README.md"), "utf8")).toBe("readme");
    await failure(mutations.createDirectory({ cwd, relativePath: "missing/child" }));
    expect(await exists(join(cwd, "missing"))).toBe(false);
  });

  it("refuses the root, escapes and paths through a symlinked parent", async () => {
    const mutations = await make();
    await symlink(join(base, "outside"), join(cwd, "escape"));
    for (const relativePath of [".", "", "../outside", "src/../..", "escape/keep.txt"]) {
      const error = await failure(
        mutations.deleteEntry({ cwd, relativePath, expectedKind: "directory" }),
      );
      expect(error._tag).toBe("WorkspacePathOutsideRootError");
    }
    await failure(mutations.createDirectory({ cwd, relativePath: "escape/new" }));
    expect(await exists(join(base, "outside/new"))).toBe(false);
    expect(await readFile(join(base, "outside/keep.txt"), "utf8")).toBe("keep");
    expect(await exists(cwd)).toBe(true);
  });

  it("removes a symlink as a link and never follows it", async () => {
    const mutations = await make();
    await symlink(join(base, "outside"), join(cwd, "link"));
    await symlink(join(base, "outside"), join(cwd, "src/inner"));
    const result = await Effect.runPromise(
      mutations.deleteEntry({ cwd, relativePath: "link", expectedKind: "directory" }),
    );
    expect(result).toEqual({ relativePath: "link", disposition: "deleted" });
    await Effect.runPromise(
      mutations.deleteEntry({ cwd, relativePath: "src", expectedKind: "directory" }),
    );
    expect(await exists(join(cwd, "link"))).toBe(false);
    expect(await exists(join(cwd, "src"))).toBe(false);
    expect(await readFile(join(base, "outside/keep.txt"), "utf8")).toBe("keep");
  });

  it("refuses a different kind and reports a missing entry", async () => {
    const mutations = await make();
    const mismatch = await failure(
      mutations.deleteEntry({ cwd, relativePath: "src", expectedKind: "file" }),
    );
    expect(mismatch).toMatchObject({ writeDisposition: "not-dispatched" });
    expect(await exists(join(cwd, "src/nested/a.txt"))).toBe(true);
    const missing = await failure(
      mutations.deleteEntry({ cwd, relativePath: "gone.txt", expectedKind: "file" }),
    );
    expect(missing).toMatchObject({ detail: WORKSPACE_ENTRY_NOT_FOUND });
  });

  it("moves to the Trash when available and never deletes after a Trash failure", async () => {
    const moved: string[] = [];
    const trash = await make({
      available: true,
      moveToTrash: async (path) => {
        moved.push(path);
      },
    });
    const result = await Effect.runPromise(
      trash.deleteEntry({ cwd, relativePath: "README.md", expectedKind: "file" }),
    );
    expect(result.disposition).toBe("trashed");
    expect(moved).toEqual([join(cwd, "README.md")]);

    const broken = await make({
      available: true,
      moveToTrash: () => Promise.reject(new Error("Trash full")),
    });
    const error = await failure(
      broken.deleteEntry({ cwd, relativePath: "src", expectedKind: "directory" }),
    );
    expect(error).toMatchObject({ detail: "Trash full", writeDisposition: "terminal" });
    expect(await exists(join(cwd, "src/nested/a.txt"))).toBe(true);
  });

  it("refuses Direct SSH targets without dispatching anything", async () => {
    const mutations = await make();
    const executionTargetId = "ssh:host=example&transport=direct-ssh";
    for (const effect of [
      mutations.createDirectory({ cwd, executionTargetId, relativePath: "x" }),
      mutations.deleteEntry({
        cwd,
        executionTargetId,
        relativePath: "src",
        expectedKind: "directory",
      }),
    ]) {
      expect(await failure(effect)).toMatchObject({ writeDisposition: "not-dispatched" });
    }
    expect(await exists(join(cwd, "src"))).toBe(true);
    expect(invalidate).not.toHaveBeenCalled();
  });
});
