import { constants as fsConstants } from "node:fs";
import * as nodeFs from "node:fs/promises";
import path from "node:path";

import { Effect } from "effect";
import { GitCommandError } from "@bigbud/contracts";

import type { GitCoreShape } from "../../git/Services/GitCore.ts";
import { CheckpointInvariantError } from "../Errors.ts";
import type {
  CheckpointPathIdentity,
  CheckpointRepositoryIdentity,
} from "../Services/CheckpointStore.ts";

function samePathIdentity(left: CheckpointPathIdentity, right: CheckpointPathIdentity): boolean {
  return (
    left.canonicalPath === right.canonicalPath &&
    left.device === right.device &&
    left.inode === right.inode
  );
}

async function assertNoSymlinkAncestors(target: string): Promise<void> {
  const resolved = path.resolve(target);
  const root = path.parse(resolved).root;
  let candidate = root;
  for (const segment of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
    candidate = path.join(candidate, segment);
    const stats = await nodeFs.lstat(candidate);
    if (stats.isSymbolicLink()) {
      const parent = path.dirname(candidate);
      const parentWritable = await nodeFs.access(parent, fsConstants.W_OK).then(
        () => true,
        () => false,
      );
      if (parentWritable) {
        throw new Error(`unsafe symlink or junction ancestor is not allowed: ${candidate}`);
      }
    }
  }
}

async function inspectDirectory(target: string): Promise<CheckpointPathIdentity> {
  const resolved = path.resolve(target);
  await assertNoSymlinkAncestors(resolved);
  const before = await nodeFs.lstat(resolved);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error(`checkpoint identity path is not a direct directory: ${resolved}`);
  }
  const canonicalPath = await nodeFs.realpath(resolved);
  await assertNoSymlinkAncestors(canonicalPath);
  const canonical = await nodeFs.lstat(canonicalPath);
  const after = await nodeFs.lstat(resolved);
  if (
    canonical.isSymbolicLink() ||
    !canonical.isDirectory() ||
    before.dev !== canonical.dev ||
    before.ino !== canonical.ino ||
    before.dev !== after.dev ||
    before.ino !== after.ino
  ) {
    throw new Error(`checkpoint identity path changed during inspection: ${resolved}`);
  }
  return { canonicalPath, device: before.dev, inode: before.ino };
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

async function readGitPointer(filePath: string, prefix?: string): Promise<string> {
  const handle = await nodeFs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  const value = await handle
    .stat()
    .then((stats) => {
      if (!stats.isFile()) throw new Error(`Git path pointer is not a file: ${filePath}`);
      return handle.readFile("utf8");
    })
    .finally(() => handle.close());
  const trimmedValue = value.trim();
  if (prefix !== undefined && !trimmedValue.startsWith(prefix)) {
    throw new Error(`Git path pointer has an invalid format: ${filePath}`);
  }
  const target = prefix === undefined ? trimmedValue : trimmedValue.slice(prefix.length).trim();
  if (!target) throw new Error(`Git path pointer is empty: ${filePath}`);
  return target;
}

async function inspectDeclaredCommonDir(worktreeRoot: string): Promise<CheckpointPathIdentity> {
  const dotGit = path.join(worktreeRoot, ".git");
  const dotGitStats = await nodeFs.lstat(dotGit);
  let gitDir: string;
  if (dotGitStats.isDirectory() && !dotGitStats.isSymbolicLink()) {
    gitDir = dotGit;
  } else {
    const pointer = await readGitPointer(dotGit, "gitdir:");
    gitDir = path.resolve(worktreeRoot, pointer);
  }
  const gitDirIdentity = await inspectDirectory(gitDir);
  const commonDirPointer = path.join(gitDirIdentity.canonicalPath, "commondir");
  const hasCommonDir = await nodeFs.lstat(commonDirPointer).then(
    () => true,
    (error) => (isMissing(error) ? false : Promise.reject(error)),
  );
  if (!hasCommonDir) return gitDirIdentity;
  const pointer = await readGitPointer(commonDirPointer);
  return inspectDirectory(path.resolve(gitDirIdentity.canonicalPath, pointer));
}

export function makeCheckpointIdentityOps(git: GitCoreShape) {
  const inspect = (operation: string, target: string) =>
    Effect.tryPromise({
      try: () => inspectDirectory(target),
      catch: (cause) =>
        new CheckpointInvariantError({
          operation,
          detail: "Checkpoint repository path identity is unsafe or unavailable.",
          cause,
        }),
    });

  const isGitRepository = Effect.fn("isGitRepository")(function* (cwd: string) {
    const operation = "CheckpointStore.isGitRepository";
    const workspace = yield* inspect(operation, cwd);
    const result = yield* git.execute({
      operation,
      cwd: workspace.canonicalPath,
      args: ["rev-parse", "--is-inside-work-tree"],
      env: { LC_ALL: "C", LANG: "C" },
      allowNonZeroExit: true,
    });
    let nestedInParentRepository = false;
    if (result.code === 0 && result.stdout.trim() === "true") {
      const topLevelResult = yield* git.execute({
        operation,
        cwd: workspace.canonicalPath,
        args: ["rev-parse", "--show-toplevel"],
        env: { LC_ALL: "C", LANG: "C" },
      });
      const topLevel = yield* inspect(operation, topLevelResult.stdout.trim());
      if (samePathIdentity(workspace, topLevel)) return true;
      nestedInParentRepository = true;
    }
    const nonRepository =
      nestedInParentRepository ||
      (result.code !== 0 && result.stderr.toLowerCase().includes("not a git repository"));
    if (!nonRepository) {
      return yield* new GitCommandError({
        operation,
        command: "git rev-parse --is-inside-work-tree",
        cwd: workspace.canonicalPath,
        detail: result.stderr.trim() || `git rev-parse exited with code ${result.code}`,
      });
    }
    const dotGitExists = yield* Effect.tryPromise({
      try: () =>
        nodeFs.lstat(path.join(workspace.canonicalPath, ".git")).then(
          () => true,
          (error) => (isMissing(error) ? false : Promise.reject(error)),
        ),
      catch: (cause) =>
        new CheckpointInvariantError({
          operation,
          detail: "Failed to verify the absence of a Git directory.",
          cause,
        }),
    });
    const workspaceAfter = yield* inspect(operation, workspace.canonicalPath);
    if (dotGitExists || !samePathIdentity(workspace, workspaceAfter)) {
      return yield* new CheckpointInvariantError({
        operation,
        detail: "Non-Git workspace proof is unsafe or changed during inspection.",
      });
    }
    return false;
  });

  const captureRepositoryIdentity = Effect.fn("captureRepositoryIdentity")(function* (cwd: string) {
    const operation = "CheckpointStore.captureRepositoryIdentity";
    const workspace = yield* inspect(operation, cwd);
    const result = yield* git.execute({
      operation,
      cwd: workspace.canonicalPath,
      args: ["rev-parse", "--git-common-dir"],
    });
    const commonDirOutput = result.stdout.trim();
    if (!commonDirOutput) {
      return yield* new CheckpointInvariantError({
        operation,
        detail: "Git returned an empty common directory.",
      });
    }
    const gitCommonDir = yield* inspect(
      operation,
      path.resolve(workspace.canonicalPath, commonDirOutput),
    );
    const worktreeRootResult = yield* git.execute({
      operation,
      cwd: workspace.canonicalPath,
      args: ["rev-parse", "--show-toplevel"],
    });
    const worktreeRoot = worktreeRootResult.stdout.trim();
    if (!worktreeRoot) {
      return yield* new CheckpointInvariantError({
        operation,
        detail: "Git returned an empty worktree root.",
      });
    }
    const declaredGitCommonDir = yield* Effect.tryPromise({
      try: () => inspectDeclaredCommonDir(worktreeRoot),
      catch: (cause) =>
        new CheckpointInvariantError({
          operation,
          detail: "Git directory declaration is unsafe or unavailable.",
          cause,
        }),
    });
    const workspaceAfter = yield* inspect(operation, workspace.canonicalPath);
    const gitCommonDirAfter = yield* inspect(operation, gitCommonDir.canonicalPath);
    if (
      !samePathIdentity(workspace, workspaceAfter) ||
      !samePathIdentity(gitCommonDir, gitCommonDirAfter) ||
      !samePathIdentity(gitCommonDir, declaredGitCommonDir)
    ) {
      return yield* new CheckpointInvariantError({
        operation,
        detail: "Workspace or Git common-directory identity changed while binding.",
      });
    }
    return { workspace, gitCommonDir } satisfies CheckpointRepositoryIdentity;
  });

  const assertRepositoryIdentity = Effect.fn("assertRepositoryIdentity")(function* (
    cwd: string,
    expected: CheckpointRepositoryIdentity,
  ) {
    const operation = "CheckpointStore.assertRepositoryIdentity";
    const actual = yield* captureRepositoryIdentity(cwd);
    if (
      !samePathIdentity(actual.workspace, expected.workspace) ||
      !samePathIdentity(actual.gitCommonDir, expected.gitCommonDir)
    ) {
      return yield* new CheckpointInvariantError({
        operation,
        detail: "Workspace or Git common-directory identity changed.",
      });
    }
    return expected.workspace.canonicalPath;
  });

  return {
    isGitRepository,
    captureRepositoryIdentity,
    assertRepositoryIdentity,
  };
}
