import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { releasePackageFiles, stampReleasePackageJson } from "./release-package-stamp.ts";
import { resolveReleaseMetadata, type ReleaseMetadata } from "./release-metadata.ts";

export interface ReleaseSourceChanges {
  /** `git status --porcelain` entries that are not the expected release version stamp. */
  readonly unexpected: ReadonlyArray<string>;
  /** Release package files whose only change from HEAD is the stamp for the release version. */
  readonly stamped: ReadonlyArray<(typeof releasePackageFiles)[number]>;
}

export interface ReleaseSourceProvenance {
  /** HEAD, suffixed `+dirty` when the tree differs from HEAD by more than the release stamp. */
  readonly sourceRevision: string;
  /** Present when the clean tree carries the release version stamp on top of HEAD. */
  readonly sourceReleaseStamp?: {
    readonly version: string;
    readonly tag: string;
    readonly files: ReadonlyArray<string>;
  };
}

function git(repo: string, args: ReadonlyArray<string>): string {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.error?.message}`);
  return result.stdout;
}

function releaseFor(version: string): ReleaseMetadata | null {
  try {
    return resolveReleaseMetadata(version);
  } catch {
    // Non-release builds (for example CI graph versions) never expect a stamp.
    return null;
  }
}

function releasePackageFile(path: string): (typeof releasePackageFiles)[number] | undefined {
  return releasePackageFiles.find((file) => file === path);
}

/** Whether `path` differs from HEAD by exactly the bytes the release stamp writes. */
function isExpectedStamp(
  repo: string,
  path: (typeof releasePackageFiles)[number],
  release: ReleaseMetadata,
): boolean {
  try {
    const head = git(repo, ["cat-file", "blob", `HEAD:${path}`]);
    // `null` means HEAD already carries the release identity, so no change is expected.
    return readFileSync(join(repo, path), "utf8") === stampReleasePackageJson(path, head, release);
  } catch {
    return false;
  }
}

/**
 * Classifies the source tree changes of `repo` against HEAD. A change is the expected release
 * stamp only when the stamping script edits that file and its working-tree bytes are exactly
 * what the stamp writes for `version` over the HEAD blob; untracked files, staged changes and
 * every other modification stay unexpected.
 */
export function releaseSourceChanges(repo: string, version: string): ReleaseSourceChanges {
  const release = releaseFor(version);
  const fields = git(repo, ["status", "--porcelain=v1", "-z"]).split("\0");
  const unexpected: string[] = [];
  const stamped: (typeof releasePackageFiles)[number][] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index];
    if (!entry) continue;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (code.startsWith("R") || code.startsWith("C")) {
      index += 1;
      unexpected.push(`${code} ${fields[index] ?? ""} -> ${path}`);
      continue;
    }
    const file = releasePackageFile(path);
    if (code === " M" && file && release && isExpectedStamp(repo, file, release))
      stamped.push(file);
    else unexpected.push(entry);
  }
  return { unexpected, stamped };
}

/** Provenance source identity for a build of `version` from `repo`, or undefined outside git. */
export function releaseSourceProvenance(
  repo: string,
  version: string,
): ReleaseSourceProvenance | undefined {
  const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" });
  if (revision.status !== 0) return undefined;
  const changes = releaseSourceChanges(repo, version);
  const commit = revision.stdout.trim();
  if (changes.unexpected.length > 0) return { sourceRevision: `${commit}+dirty` };
  if (changes.stamped.length === 0) return { sourceRevision: commit };
  const release = resolveReleaseMetadata(version);
  return {
    sourceRevision: commit,
    sourceReleaseStamp: {
      version: release.version,
      tag: release.tag,
      files: changes.stamped.toSorted(),
    },
  };
}
