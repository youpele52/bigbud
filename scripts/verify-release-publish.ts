#!/usr/bin/env node
/**
 * Release publish helper, used by the `release` job in `.github/workflows/release.yml`.
 *
 *   node scripts/verify-release-publish.ts resolve --github-output <path>
 *     Expands RELEASE_FILE_PATTERNS (newline-separated globs) to one deduplicated file list and
 *     writes it as the multiline step output `files` for softprops/action-gh-release.
 *
 *   node scripts/verify-release-publish.ts verify --repo <owner/name> --tag <tag>
 *       --prerelease <true|false> --make-latest <true|false|legacy> [--attempts 3]
 *     Finds the release (drafts included), re-uploads missing, incomplete or wrong-size assets with
 *     `gh release upload --clobber`, publishes a draft left behind by a failed upload, and exits 1
 *     unless every expected asset is uploaded and the release is published with the right channel.
 *
 * Needs `gh` with GH_TOKEN (contents: write). Writes a summary to $GITHUB_STEP_SUMMARY when set.
 */
import { execFile } from "node:child_process";
import { appendFileSync, globSync, statSync } from "node:fs";
import { basename } from "node:path";
import { promisify } from "node:util";

import { argValue } from "./lib/report-cli.ts";
import {
  checkReleaseState,
  findReleaseByTag,
  formatPublishSummary,
  healReleaseAssets,
  parsePatternList,
  parseReleaseLines,
  parseRemoteAssetLines,
  resolveReleaseFiles,
} from "./lib/release-publish-assets.ts";
import type { LocalAsset } from "./lib/release-publish-assets.ts";

const run = promisify(execFile);
const gh = async (args: string[]) =>
  (await run("gh", args, { maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60_000 })).stdout;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function required(flag: string): string {
  const value = argValue(flag);
  if (!value || value.startsWith("--")) throw new Error(`Missing ${flag}.`);
  return value;
}

function resolveFiles(): string[] {
  const patterns = parsePatternList(process.env.RELEASE_FILE_PATTERNS ?? "");
  if (patterns.length === 0) throw new Error("RELEASE_FILE_PATTERNS is empty.");
  const matches = patterns.map((pattern) => ({
    pattern,
    files: globSync(pattern)
      .filter((path) => statSync(path).isFile())
      .toSorted(),
  }));
  const resolved = resolveReleaseFiles(matches);
  if (resolved.problems.length > 0) {
    throw new Error(`Release files are invalid:\n- ${resolved.problems.join("\n- ")}`);
  }
  return [...resolved.files];
}

function writeSummary(text: string): void {
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
}

async function resolveCommand(): Promise<void> {
  const files = resolveFiles();
  const delimiter = `RELEASE_FILES_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  appendFileSync(
    required("--github-output"),
    `files<<${delimiter}\n${files.join("\n")}\n${delimiter}\n`,
  );
  console.log(`Resolved ${files.length} release files:\n${files.join("\n")}`);
}

async function verifyCommand(): Promise<void> {
  const repo = required("--repo");
  const tag = required("--tag");
  const prerelease = required("--prerelease") === "true";
  const makeLatest = required("--make-latest");
  const attempts = Number(argValue("--attempts") ?? "3");
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error("--attempts must be >= 1.");

  const expected: LocalAsset[] = resolveFiles().map((path) => ({
    path,
    name: basename(path),
    size: statSync(path).size,
  }));
  const releases = parseReleaseLines(
    await gh([
      "api",
      "--paginate",
      `repos/${repo}/releases?per_page=100`,
      "--jq",
      ".[] | {id, tag_name, draft, prerelease}",
    ]),
  );
  const found = findReleaseByTag(releases, tag);
  if (!found.release) {
    writeSummary(`### Release assets\n\n- ${found.problem}\n`);
    process.exitCode = 1;
    return;
  }
  const releaseId = found.release.id;
  const result = await healReleaseAssets({
    expected,
    listAssets: async () =>
      parseRemoteAssetLines(
        await gh([
          "api",
          "--paginate",
          `repos/${repo}/releases/${releaseId}/assets?per_page=100`,
          "--jq",
          ".[] | {name, state, size}",
        ]),
      ),
    upload: async (asset) => {
      await gh(["release", "upload", tag, asset.path, "--clobber", "--repo", repo]);
    },
    attempts,
    sleep,
    retryDelayMs: 5_000,
    log: (message) => console.log(message),
  });

  let releaseProblems: string[] = [];
  if (result.problems.length === 0) {
    // A stable release stays a draft when an upload fails; finish what the action would have done.
    if (found.release.draft) {
      console.log(`Publishing draft release ${releaseId} for ${tag}.`);
      await gh([
        "api",
        "--method",
        "PATCH",
        `repos/${repo}/releases/${releaseId}`,
        "-F",
        "draft=false",
        "-f",
        `make_latest=${makeLatest}`,
      ]);
    }
    const release = JSON.parse(await gh(["api", `repos/${repo}/releases/${releaseId}`])) as unknown;
    releaseProblems = checkReleaseState(release, { tag, prerelease });
  } else if (found.release.draft) {
    releaseProblems = ["Assets are incomplete, so the draft release was left unpublished."];
  }
  writeSummary(formatPublishSummary(tag, expected.length, result, releaseProblems));
  if (releaseProblems.length > 0 || result.problems.length > 0) process.exitCode = 1;
}

const command = process.argv[2];
if (command === "resolve") await resolveCommand();
else if (command === "verify") await verifyCommand();
else throw new Error("Usage: node scripts/verify-release-publish.ts <resolve|verify> [flags]");
