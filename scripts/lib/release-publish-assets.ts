/**
 * Publish-asset logic for the release job: resolve the upload patterns to one deduplicated file
 * list, compare it with the assets GitHub actually has, and re-upload what is missing or broken.
 *
 * softprops/action-gh-release concatenates the matches of every pattern and uploads them with
 * `Promise.all`, so a file matched by two patterns is uploaded twice at once and the second upload
 * fails on GitHub's asset-metadata race (release v0.4.0-beta.3). Passing it this list avoids that.
 *
 * Pure logic and an injected heal loop only; `scripts/verify-release-publish.ts` does the IO.
 */
import { basename } from "node:path";

export interface PatternMatches {
  readonly pattern: string;
  /** Regular files matched by the pattern, as paths relative to the working directory. */
  readonly files: ReadonlyArray<string>;
}

export interface ResolvedReleaseFiles {
  readonly files: ReadonlyArray<string>;
  readonly problems: ReadonlyArray<string>;
}

export interface LocalAsset {
  readonly path: string;
  readonly name: string;
  readonly size: number;
}

export interface RemoteAsset {
  readonly name: string;
  /** `uploaded` when complete; `open` while (or after a failed) upload. */
  readonly state: string;
  readonly size: number;
}

export interface AssetDiff {
  readonly missing: ReadonlyArray<string>;
  readonly notUploaded: ReadonlyArray<string>;
  readonly sizeMismatch: ReadonlyArray<string>;
  /** On the release but not expected (for example a manual upload); reported, not fatal. */
  readonly extra: ReadonlyArray<string>;
}

export interface ReleaseExpectation {
  readonly tag: string;
  readonly prerelease: boolean;
}

const GLOB_CHARACTERS = /[*?[\]{}!]/;

/** Non-empty, trimmed lines of a newline-separated pattern list. */
export function parsePatternList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * One entry per asset name, in first-match order. Fails on an unmatched pattern (the action's
 * `fail_on_unmatched_files`), on two different files with the same asset name, and on file names
 * the action would treat as a glob.
 */
export function resolveReleaseFiles(matches: ReadonlyArray<PatternMatches>): ResolvedReleaseFiles {
  const problems: string[] = [];
  const byName = new Map<string, string>();
  for (const { pattern, files } of matches) {
    if (files.length === 0) problems.push(`Pattern '${pattern}' does not match any files.`);
    for (const file of files) {
      const name = basename(file);
      const previous = byName.get(name);
      if (previous === undefined) byName.set(name, file);
      else if (previous !== file) {
        problems.push(`Asset name '${name}' would come from both ${previous} and ${file}.`);
      }
      if (GLOB_CHARACTERS.test(file)) problems.push(`File '${file}' contains glob characters.`);
    }
  }
  return { files: [...byName.values()], problems };
}

/** Compares the expected local files with the release's assets. */
export function diffReleaseAssets(
  expected: ReadonlyArray<LocalAsset>,
  remote: ReadonlyArray<RemoteAsset>,
): AssetDiff {
  const remoteByName = new Map(remote.map((asset) => [asset.name, asset]));
  const expectedNames = new Set(expected.map((asset) => asset.name));
  const missing: string[] = [];
  const notUploaded: string[] = [];
  const sizeMismatch: string[] = [];
  for (const asset of expected) {
    const found = remoteByName.get(asset.name);
    if (found === undefined) missing.push(asset.name);
    else if (found.state !== "uploaded") notUploaded.push(asset.name);
    else if (found.size !== asset.size) sizeMismatch.push(asset.name);
  }
  const extra = remote.map((asset) => asset.name).filter((name) => !expectedNames.has(name));
  return { missing, notUploaded, sizeMismatch, extra };
}

export const assetsToRepair = (diff: AssetDiff): string[] => [
  ...diff.missing,
  ...diff.notUploaded,
  ...diff.sizeMismatch,
];

export interface ReleaseSummary {
  readonly id: number;
  readonly tagName: string;
  readonly draft: boolean;
  readonly prerelease: boolean;
}

/**
 * Parses one `gh api --paginate repos/{repo}/releases --jq '.[] | {id, tag_name, draft, prerelease}'`
 * line per release. The releases list (unlike the by-tag endpoint) includes drafts, which the
 * action leaves behind when an upload fails for a stable release.
 */
export function parseReleaseLines(text: string): ReleaseSummary[] {
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (typeof value.id !== "number" || typeof value.tag_name !== "string") {
        throw new Error(`Release line ${index + 1} has no id or tag_name.`);
      }
      return {
        id: value.id,
        tagName: value.tag_name,
        draft: value.draft === true,
        prerelease: value.prerelease === true,
      };
    });
}

/** The release for `tag`; a published one wins over drafts. Fails on ambiguity. */
export function findReleaseByTag(
  releases: ReadonlyArray<ReleaseSummary>,
  tag: string,
): { release?: ReleaseSummary; problem?: string } {
  const matches = releases.filter((release) => release.tagName === tag);
  const published = matches.filter((release) => !release.draft);
  if (published.length === 1) return { release: published[0]! };
  if (published.length > 1) return { problem: `More than one published release has tag ${tag}.` };
  if (matches.length === 1) return { release: matches[0]! };
  if (matches.length > 1) return { problem: `More than one draft release has tag ${tag}.` };
  return {
    problem: `No release (published or draft) has tag ${tag}; publishing did not create it.`,
  };
}

/** Problems with the release itself (it must be the published tag with the right channel). */
export function checkReleaseState(release: unknown, expected: ReleaseExpectation): string[] {
  if (typeof release !== "object" || release === null)
    return ["Release response is not an object."];
  const record = release as Record<string, unknown>;
  const problems: string[] = [];
  if (record.tag_name !== expected.tag) {
    problems.push(`Release tag is '${String(record.tag_name)}', expected '${expected.tag}'.`);
  }
  if (record.draft !== false) problems.push("Release is still a draft.");
  if (record.prerelease !== expected.prerelease) {
    problems.push(
      `Release prerelease is ${String(record.prerelease)}, expected ${expected.prerelease}.`,
    );
  }
  return problems;
}

/** Parses one `gh api --jq '.[] | {name, state, size}'` line per asset. */
export function parseRemoteAssetLines(text: string): RemoteAsset[] {
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (typeof value.name !== "string" || typeof value.state !== "string") {
        throw new Error(`Release asset line ${index + 1} has no name or state.`);
      }
      return { name: value.name, state: value.state, size: Number(value.size) };
    });
}

export interface HealOptions {
  readonly expected: ReadonlyArray<LocalAsset>;
  readonly listAssets: () => Promise<RemoteAsset[]>;
  /** Uploads (replacing) one local file. */
  readonly upload: (asset: LocalAsset) => Promise<void>;
  readonly attempts: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly retryDelayMs: number;
  readonly log: (message: string) => void;
}

export interface HealResult {
  readonly diff: AssetDiff;
  readonly repaired: ReadonlyArray<string>;
  readonly problems: ReadonlyArray<string>;
}

const describeDiff = (diff: AssetDiff): string[] => [
  ...diff.missing.map((name) => `${name}: missing from the release`),
  ...diff.notUploaded.map((name) => `${name}: not in state 'uploaded'`),
  ...diff.sizeMismatch.map((name) => `${name}: size differs from the local file`),
];

/**
 * Re-uploads missing, incomplete or wrong-size assets for up to `attempts` rounds, re-listing the
 * release after each round. Upload errors are logged and retried; only the final listing decides.
 */
export async function healReleaseAssets(options: HealOptions): Promise<HealResult> {
  const byName = new Map(options.expected.map((asset) => [asset.name, asset]));
  const repaired = new Set<string>();
  let diff = diffReleaseAssets(options.expected, await options.listAssets());
  for (
    let attempt = 1;
    attempt <= options.attempts && assetsToRepair(diff).length > 0;
    attempt += 1
  ) {
    for (const line of describeDiff(diff)) options.log(`Repairing (attempt ${attempt}): ${line}`);
    for (const name of assetsToRepair(diff)) {
      try {
        await options.upload(byName.get(name)!);
        repaired.add(name);
      } catch (error) {
        options.log(
          `Upload of ${name} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    await options.sleep(options.retryDelayMs * attempt);
    diff = diffReleaseAssets(options.expected, await options.listAssets());
  }
  return { diff, repaired: [...repaired], problems: describeDiff(diff) };
}

/** Markdown for the step summary. */
export function formatPublishSummary(
  tag: string,
  expectedCount: number,
  result: HealResult,
  releaseProblems: ReadonlyArray<string>,
): string {
  const problems = [...releaseProblems, ...result.problems];
  const lines = [
    "### Release assets",
    "",
    problems.length === 0
      ? `${tag}: all ${expectedCount} expected assets are uploaded with matching sizes.`
      : `${tag}: verification failed with ${problems.length} problem(s).`,
  ];
  if (result.repaired.length > 0) lines.push("", `Re-uploaded: ${result.repaired.join(", ")}`);
  if (result.diff.extra.length > 0) {
    lines.push("", `Not in the expected list (left in place): ${result.diff.extra.join(", ")}`);
  }
  if (problems.length > 0) lines.push("", ...problems.map((problem) => `- ${problem}`));
  return `${lines.join("\n")}\n`;
}
