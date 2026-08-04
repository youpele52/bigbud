import * as nodeFs from "node:fs/promises";
import path from "node:path";

import type {
  PurgeJob,
  PurgeResource,
  PurgePathIdentity,
  PurgeResourceIdentity,
} from "../../persistence/Services/PurgeJobRepository.ts";
import type { ServerConfigShape } from "../../startup/config.ts";
import { removeWithoutFollowingSymlinks } from "./EntityPurge.resources.remove.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function isContained(root: string, target: string): boolean {
  return target !== root && target.startsWith(`${root}${path.sep}`);
}

function validateRelativePath(relativePath: string): void {
  if (
    relativePath.length === 0 ||
    relativePath.includes("\0") ||
    path.isAbsolute(relativePath) ||
    relativePath
      .split(/[\\/]/u)
      .some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error("unsafe purge resource path");
  }
}

async function existingAncestor(target: string): Promise<string> {
  let candidate = path.dirname(target);
  for (;;) {
    try {
      await nodeFs.lstat(candidate);
      return candidate;
    } catch (error) {
      if (!isMissing(error)) throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

async function assertNoSymlinkAncestors(root: string, target: string): Promise<void> {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget !== resolvedRoot && !isContained(resolvedRoot, resolvedTarget)) {
    throw new Error("purge resource ancestor escapes its managed root");
  }
  const rootStats = await nodeFs.lstat(resolvedRoot);
  if (rootStats.isSymbolicLink()) throw new Error("symlink purge resource root is not allowed");
  let candidate = resolvedRoot;
  const relative = path.relative(resolvedRoot, resolvedTarget);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    candidate = path.join(candidate, segment);
    let stats;
    try {
      stats = await nodeFs.lstat(candidate);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    if (stats.isSymbolicLink()) throw new Error("symlink purge resource ancestor is not allowed");
  }
}

async function capturePathIdentity(target: string): Promise<PurgePathIdentity> {
  const stats = await nodeFs.lstat(target);
  if (stats.isSymbolicLink()) throw new Error("symlink purge resource ancestor is not allowed");
  return {
    canonicalPath: await nodeFs.realpath(target),
    device: stats.dev,
    inode: stats.ino,
  };
}

function samePathIdentity(left: PurgePathIdentity, right: PurgePathIdentity): boolean {
  return (
    left.canonicalPath === right.canonicalPath &&
    left.device === right.device &&
    left.inode === right.inode
  );
}

export interface ResolvedPurgeResource {
  readonly root: string;
  readonly target: string;
}

export function resourceRoot(config: ServerConfigShape, kind: PurgeResource["kind"]): string {
  switch (kind) {
    case "attachment":
      return config.attachmentsDir;
    case "provider-log":
      return config.providerLogsDir;
    case "terminal-history":
      return config.terminalLogsDir;
    case "project-memory":
      return path.join(config.stateDir, "memory", "projects");
    case "project-notes":
      return config.notesDir;
    case "project-kanban":
      return config.kanbanDir;
    case "managed-worktree":
      return config.worktreesDir;
  }
}

export function resolvePurgeResource(
  config: ServerConfigShape,
  resource: PurgeResource,
): ResolvedPurgeResource {
  validateRelativePath(resource.relativePath);
  const root = path.resolve(resourceRoot(config, resource.kind));
  const target = path.resolve(root, resource.relativePath);
  if (!isContained(root, target)) throw new Error("purge resource escapes its managed root");
  return { root, target };
}

export function managedRelativePath(root: string, target: string): string | null {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (!isContained(resolvedRoot, resolvedTarget)) return null;
  const relativePath = path.relative(resolvedRoot, resolvedTarget);
  try {
    validateRelativePath(relativePath);
    return relativePath;
  } catch {
    return null;
  }
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || isContained(left, right) || isContained(right, left);
}

export function resourcesConflict(
  left: {
    readonly resolved: ResolvedPurgeResource;
    readonly identity: PurgeResourceIdentity | null;
  },
  right: {
    readonly resolved: ResolvedPurgeResource;
    readonly identity: PurgeResourceIdentity | null;
  },
): boolean {
  return (
    pathsOverlap(left.resolved.target, right.resolved.target) ||
    (left.identity !== null &&
      right.identity !== null &&
      pathsOverlap(left.identity.canonicalPath, right.identity.canonicalPath)) ||
    (left.identity !== null &&
      right.identity !== null &&
      left.identity.device === right.identity.device &&
      left.identity.inode === right.identity.inode)
  );
}

export async function captureResourceIdentity(
  resolved: ResolvedPurgeResource,
): Promise<PurgeResourceIdentity | null> {
  await assertNoSymlinkAncestors(resolved.root, resolved.root);
  await assertNoSymlinkAncestors(resolved.root, path.dirname(resolved.target));
  const root = await capturePathIdentity(resolved.root);
  const parentPath = await existingAncestor(resolved.target);
  const parent = await capturePathIdentity(parentPath);
  if (
    parent.canonicalPath !== root.canonicalPath &&
    !isContained(root.canonicalPath, parent.canonicalPath)
  ) {
    throw new Error("purge resource parent escapes its canonical managed root");
  }
  let stats;
  try {
    stats = await nodeFs.lstat(resolved.target);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  if (stats.isSymbolicLink()) throw new Error("symlink purge resources are not allowed");
  const type = stats.isDirectory() ? "directory" : stats.isFile() ? "file" : null;
  if (!type) throw new Error("unsupported purge resource type");
  const canonicalPath = await nodeFs.realpath(resolved.target);
  if (!isContained(root.canonicalPath, canonicalPath)) {
    throw new Error("purge resource escapes its canonical managed root");
  }
  return {
    declaredPath: resolved.target,
    canonicalPath,
    device: stats.dev,
    inode: stats.ino,
    changedAtMs: stats.ctimeMs,
    type,
    root,
    parent,
  };
}

function sameIdentity(left: PurgeResourceIdentity, right: PurgeResourceIdentity): boolean {
  return (
    left.canonicalPath === right.canonicalPath &&
    left.declaredPath === right.declaredPath &&
    left.device === right.device &&
    left.inode === right.inode &&
    (left.changedAtMs === null ||
      right.changedAtMs === null ||
      left.changedAtMs === right.changedAtMs) &&
    left.type === right.type &&
    left.root !== null &&
    right.root !== null &&
    samePathIdentity(left.root, right.root) &&
    left.parent !== null &&
    right.parent !== null &&
    samePathIdentity(left.parent, right.parent)
  );
}

function quarantinePath(resource: PurgeResource, target: string): string {
  const name = resource.quarantineName;
  if (
    name === null ||
    !name.startsWith(".bigbud-purge-") ||
    name.includes("/") ||
    name.includes("\\") ||
    path.basename(name) !== name
  ) {
    throw new Error("purge resource lacks a safe private quarantine name");
  }
  return path.join(path.dirname(target), name);
}

async function identityAtQuarantine(
  target: string,
  expected: PurgeResourceIdentity,
): Promise<boolean> {
  const stats = await nodeFs.lstat(target);
  return (
    stats.dev === expected.device &&
    stats.ino === expected.inode &&
    (expected.type === "directory" ? stats.isDirectory() : stats.isFile()) &&
    !stats.isSymbolicLink()
  );
}

export async function deleteResourceAtomically(input: {
  readonly jobId: string;
  readonly resolved: ResolvedPurgeResource;
  readonly resource: PurgeResource;
  readonly beforeRemove?: (quarantine: string) => Promise<void>;
}): Promise<{ readonly removed: boolean; readonly knownBytes: number }> {
  const quarantine = quarantinePath(input.resource, input.resolved.target);
  const targetExists = await nodeFs.lstat(input.resolved.target).then(
    () => true,
    (error) => {
      if (isMissing(error)) return false;
      throw error;
    },
  );
  const quarantineExists = await nodeFs.lstat(quarantine).then(
    () => true,
    (error) => {
      if (isMissing(error)) return false;
      throw error;
    },
  );
  const expected = input.resource.identity;
  if (!expected) {
    if (targetExists || quarantineExists)
      throw new Error("resource appeared after manifest capture");
    return { removed: false, knownBytes: 0 };
  }
  if (expected.root === null || expected.parent === null) {
    throw new Error("purge resource lacks bound root and parent identity");
  }
  await assertNoSymlinkAncestors(input.resolved.root, input.resolved.root);
  await assertNoSymlinkAncestors(input.resolved.root, path.dirname(input.resolved.target));
  const currentRoot = await capturePathIdentity(input.resolved.root);
  const currentParent = await capturePathIdentity(path.dirname(input.resolved.target));
  if (
    !samePathIdentity(currentRoot, expected.root) ||
    !samePathIdentity(currentParent, expected.parent)
  ) {
    throw new Error("purge resource root or parent identity changed");
  }
  if (targetExists) {
    if (quarantineExists) throw new Error("purge quarantine collision");
    const current = await captureResourceIdentity(input.resolved);
    if (!current || !sameIdentity(current, expected))
      throw new Error("purge resource identity changed");
    await nodeFs.rename(input.resolved.target, quarantine);
  } else if (!quarantineExists) {
    return { removed: false, knownBytes: 0 };
  }
  try {
    const postRenameRoot = await capturePathIdentity(input.resolved.root);
    const postRenameParent = await capturePathIdentity(path.dirname(quarantine));
    if (
      !samePathIdentity(postRenameRoot, expected.root) ||
      !samePathIdentity(postRenameParent, expected.parent)
    ) {
      throw new Error("purge resource root or parent changed after quarantine");
    }
    const canonicalRoot = postRenameRoot.canonicalPath;
    const canonicalQuarantine = await nodeFs.realpath(quarantine);
    if (!isContained(canonicalRoot, canonicalQuarantine)) {
      throw new Error("quarantined purge resource escaped its canonical root");
    }
    if (!(await identityAtQuarantine(quarantine, expected))) {
      throw new Error("quarantined purge resource identity changed");
    }
  } catch (error) {
    const targetStillAbsent = await nodeFs.lstat(input.resolved.target).then(
      () => false,
      (cause) => (isMissing(cause) ? true : Promise.reject(cause)),
    );
    if (targetStillAbsent) {
      await nodeFs.rename(quarantine, input.resolved.target).catch(() => undefined);
    }
    throw error;
  }
  await input.beforeRemove?.(quarantine);
  await assertNoSymlinkAncestors(input.resolved.root, input.resolved.root);
  await assertNoSymlinkAncestors(input.resolved.root, path.dirname(quarantine));
  const finalRoot = await capturePathIdentity(input.resolved.root);
  const finalParent = await capturePathIdentity(path.dirname(quarantine));
  if (
    !samePathIdentity(finalRoot, expected.root) ||
    !samePathIdentity(finalParent, expected.parent) ||
    !isContained(finalRoot.canonicalPath, await nodeFs.realpath(quarantine)) ||
    !(await identityAtQuarantine(quarantine, expected))
  ) {
    throw new Error("quarantined purge resource changed before removal");
  }
  const knownBytes = await removeWithoutFollowingSymlinks(quarantine, expected);
  return { removed: true, knownBytes };
}

export async function verifyResourceAbsent(input: {
  readonly jobId: string;
  readonly resolved: ResolvedPurgeResource;
  readonly resource: PurgeResource;
}): Promise<void> {
  for (const target of [
    input.resolved.target,
    quarantinePath(input.resource, input.resolved.target),
  ]) {
    const exists = await nodeFs.lstat(target).then(
      () => true,
      (error) => {
        if (isMissing(error)) return false;
        throw error;
      },
    );
    if (exists) throw new Error("managed purge resource remains");
  }
}

export async function verifyResourcePresent(input: {
  readonly resolved: ResolvedPurgeResource;
  readonly resource: PurgeResource;
}): Promise<void> {
  const expected = input.resource.identity;
  if (!expected) throw new Error("shared purge resource lacks a captured identity");
  const current = await captureResourceIdentity(input.resolved);
  if (!current || !sameIdentity(current, expected)) {
    throw new Error("shared purge resource identity changed or disappeared");
  }
  const quarantine = quarantinePath(input.resource, input.resolved.target);
  const quarantineExists = await nodeFs.lstat(quarantine).then(
    () => true,
    (error) => (isMissing(error) ? false : Promise.reject(error)),
  );
  if (quarantineExists) throw new Error("shared purge resource was quarantined");
}

export function assertManifestResourceKind(job: PurgeJob, resource: PurgeResource): void {
  const threadKind =
    resource.kind === "attachment" ||
    resource.kind === "managed-worktree" ||
    resource.kind === "provider-log" ||
    resource.kind === "terminal-history";
  if ((job.entityKind === "thread") !== threadKind) {
    throw new Error("purge manifest resource kind does not match its entity");
  }
}
