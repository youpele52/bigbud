import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

function overlaps(left: string, right: string) {
  const within = (root: string, child: string) => {
    const relative = path.relative(root, child);
    return (
      !relative ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  };
  return within(left, right) || within(right, left);
}

async function info(filename: string) {
  try {
    return await lstat(filename);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

/** Validate the existing parent before creating storage; never create owned files in a repository. */
export async function assertV2ProfileStorageLocation(profile: string) {
  let ancestor = await realpath(path.dirname(profile));
  for (let depth = 0; depth < 128; depth++) {
    if (await info(path.join(ancestor, ".git")))
      throw new Error(
        "V2 runtime storage must be outside repository/worktree roots; choose a separate dedicated profile path.",
      );
    const parent = path.dirname(ancestor);
    if (parent === ancestor) return;
    ancestor = parent;
  }
  throw new Error("V2 storage boundary: repository ancestry exceeds bound.");
}

async function pointer(filename: string) {
  const stat = await info(filename);
  if (!stat) return undefined;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096)
    throw new Error("V2 storage boundary: unsafe repository pointer.");
  const handle = await open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const actual = await handle.stat();
    if (actual.dev !== stat.dev || actual.ino !== stat.ino || actual.size > 4096)
      throw new Error("V2 storage boundary: repository pointer changed.");
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 4096) throw new Error("V2 storage boundary: repository pointer exceeds bound.");
    return buffer.subarray(0, bytesRead).toString("utf8").trim();
  } finally {
    await handle.close();
  }
}

/** Reject canonical overlap with Location, ancestor repositories and linked worktree roots. */
export async function assertV2WorkspaceStorageSeparate(profile: string, workspace: string) {
  const storage = await realpath(profile);
  const directory = await realpath(workspace);
  const assert = (root: string) => {
    if (overlaps(storage, root))
      throw new Error(
        "V2 runtime storage must be outside workspace and repository/worktree roots; choose a separate dedicated profile path.",
      );
  };
  assert(directory);
  let ancestor = directory;
  for (let depth = 0; depth < 128; depth++) {
    const marker = path.join(ancestor, ".git");
    const stat = await info(marker);
    if (stat) {
      assert(ancestor);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
        throw new Error("V2 storage boundary: unsafe repository marker.");
      const reference = stat.isFile() ? await pointer(marker) : undefined;
      if (reference && !reference.startsWith("gitdir: "))
        throw new Error("V2 storage boundary: invalid worktree marker.");
      const gitDir = await realpath(
        reference ? path.resolve(ancestor, reference.slice(8)) : marker,
      );
      const common = await pointer(path.join(gitDir, "commondir"));
      const commonDir = common ? await realpath(path.resolve(gitDir, common)) : gitDir;
      if (path.basename(commonDir) === ".git") assert(await realpath(path.dirname(commonDir)));
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) return;
    ancestor = parent;
  }
  throw new Error("V2 storage boundary: repository ancestry exceeds bound.");
}
