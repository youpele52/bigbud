/**
 * Checks the published remote-agent staging script (D3: users get the reviewed release asset,
 * never the moving main branch).
 *
 * - The retired site path `https://bigbud.app/remote-agent.sh` must return 404, so older apps'
 *   copied commands fail cleanly instead of piping HTML into `sh`.
 * - `--download <ref>` follows `https://bigbud.app/download/<ref>/remote-agent` and requires the
 *   body to equal `scripts/release-assets/remote-agent.sh` once the stamped `DEFAULT_VERSION` line
 *   is normalised, with the stamp equal to the release the link resolved to.
 * - `--release v<x>` checks that release's `remote-agent.sh` asset the same way.
 *
 * Exit codes: 0 every source is as expected, 1 any source differs or is served from a disallowed
 * location (including oversize content), 2 a source could not be fetched and none differed.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { boundedHttpsGet, type BoundedFetchResult } from "./lib/bounded-https-fetch.ts";
import {
  normalizeStampedScript,
  resolvedReleaseTag,
  stampForTag,
  validateDownloadRef,
} from "./verify-published-remote-agent-script.stamp.ts";

export const SITE_ORIGIN = "https://bigbud.app";
export const RETIRED_SCRIPT_URL = `${SITE_ORIGIN}/remote-agent.sh`;
export const DEFAULT_REPOSITORY = "youpele52/bigbud";
export const DEFAULT_TIMEOUT_MS = 15_000;
/** The repo script is a few KiB; anything past this cannot be it. */
export const MAX_SCRIPT_BYTES = 256 * 1024;
const REPO_SCRIPT_LABEL = "scripts/release-assets/remote-agent.sh";
const REPO_SCRIPT_PATH = fileURLToPath(new URL(`../${REPO_SCRIPT_LABEL}`, import.meta.url));

export const SITE_HOSTS: ReadonlySet<string> = new Set(["bigbud.app", "www.bigbud.app"]);
export const RELEASE_HOSTS: ReadonlySet<string> = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);
const DOWNLOAD_HOSTS: ReadonlySet<string> = new Set([...SITE_HOSTS, ...RELEASE_HOSTS]);
const RAW_GITHUB_HOST = "raw.githubusercontent.com";

export type SourceStatus = "match" | "removed" | "mismatch" | "unreachable";

export interface SourceReport {
  readonly label: string;
  readonly url: string;
  readonly status: SourceStatus;
  readonly lines: ReadonlyArray<string>;
}

export interface VerifyOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly expected: Buffer;
  readonly release?: string;
  readonly download?: string;
  readonly repository?: string;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

/** What a fetched script must contain: the stamp is fixed, or read from the redirect chain. */
type StampExpectation =
  | { readonly kind: "fixed"; readonly stamp: string }
  | { readonly kind: "resolved"; readonly repository: string };

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export function releaseScriptUrl(repository: string, release: string): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error(`--repository must be owner/repository, got '${repository}'.`);
  }
  const tag = release.startsWith("v") ? release : `v${release}`;
  if (!/^v[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(tag)) {
    throw new Error(`--release must be a version tag such as v1.2.3, got '${release}'.`);
  }
  return `https://github.com/${repository}/releases/download/${tag}/remote-agent.sh`;
}

export function downloadUrl(ref: string): string {
  return `${SITE_ORIGIN}/download/${validateDownloadRef(ref)}/remote-agent`;
}

function failureReport(label: string, url: string, result: BoundedFetchResult): SourceReport {
  switch (result.kind) {
    case "redirect-disallowed": {
      const host = new URL(result.location).hostname;
      const lines = [`  redirect to a disallowed location: ${result.from} -> ${result.location}`];
      if (host === RAW_GITHUB_HOST) {
        lines.push(
          "  raw.githubusercontent.com serves a moving branch, not the reviewed public file (D3).",
        );
      }
      return { label, url, status: "mismatch", lines };
    }
    case "oversize":
      return {
        label,
        url,
        status: "mismatch",
        lines: [`  response exceeds ${result.limit} bytes; it cannot be the repository script`],
      };
    case "unreachable":
      return { label, url, status: "unreachable", lines: [`  ${result.url}: ${result.reason}`] };
    case "ok":
      throw new Error("failureReport needs a failed fetch result.");
  }
}

function classifyScript(
  label: string,
  url: string,
  result: BoundedFetchResult,
  expectedSha: string,
  expectation: StampExpectation,
): SourceReport {
  if (result.kind !== "ok") return failureReport(label, url, result);
  const { normalized, stamp } = normalizeStampedScript(result.bytes);
  const actual = sha256(normalized);
  const via = result.hops.length > 1 ? [`  via: ${result.hops.join(" -> ")}`] : [];
  const lines = [
    `  sha256 (stamp normalised): ${actual} (${result.bytes.length} bytes)`,
    `  stamp: ${stamp === null ? "missing" : JSON.stringify(stamp)}`,
    ...via,
  ];
  const problems: string[] = [];
  if (actual !== expectedSha) problems.push(`  expected: ${expectedSha}`, ...mismatchHints(result));
  const tag =
    expectation.kind === "fixed" ? null : resolvedReleaseTag(result.hops, expectation.repository);
  const wanted = expectation.kind === "fixed" ? expectation.stamp : tag && stampForTag(tag);
  if (!wanted) problems.push("  could not tell which release the link resolved to");
  else if (stamp !== wanted) problems.push(`  expected stamp: ${JSON.stringify(wanted)}`);
  return problems.length === 0
    ? { label, url, status: "match", lines }
    : { label, url, status: "mismatch", lines: [...lines, ...problems] };
}

function classifyRetired(label: string, url: string, result: BoundedFetchResult): SourceReport {
  if (result.kind === "unreachable" && result.status === 404) {
    return { label, url, status: "removed", lines: ["  HTTP 404 as required"] };
  }
  if (result.kind !== "ok") return failureReport(label, url, result);
  return {
    label,
    url,
    status: "mismatch",
    lines: [
      `  served ${result.bytes.length} bytes (${result.contentType || "no content type"});`,
      "  the retired path must return 404 so old copied commands fail cleanly.",
    ],
  };
}

function mismatchHints(result: { bytes: Buffer; contentType: string }): string[] {
  const head = result.bytes.subarray(0, 512).toString("utf8").trimStart().toLowerCase();
  if (!result.contentType.includes("text/html") && !/^<(!doctype html|html)/.test(head)) return [];
  return [
    `  served ${result.contentType || "HTML"}: likely the site's fallback page,`,
    "  so the download link is not deployed at this URL.",
  ];
}

export async function verifyPublishedRemoteAgentScript(
  options: VerifyOptions,
): Promise<ReadonlyArray<SourceReport>> {
  const expectedSha = sha256(options.expected);
  const fetchOptions = {
    ...(options.fetch ? { fetch: options.fetch } : {}),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBytes: options.maxBytes ?? MAX_SCRIPT_BYTES,
  };
  const get = (url: string, hosts: ReadonlySet<string>) =>
    boundedHttpsGet(url, { ...fetchOptions, allowedHosts: hosts });
  const checks: Array<Promise<SourceReport>> = [
    get(RETIRED_SCRIPT_URL, SITE_HOSTS).then((result) =>
      classifyRetired("retired site path", RETIRED_SCRIPT_URL, result),
    ),
  ];
  if (options.download) {
    const url = downloadUrl(options.download);
    const expectation = { kind: "resolved", repository: DEFAULT_REPOSITORY } as const;
    checks.push(
      get(url, DOWNLOAD_HOSTS).then((result) =>
        classifyScript(`download ${options.download}`, url, result, expectedSha, expectation),
      ),
    );
  }
  if (options.release) {
    const url = releaseScriptUrl(options.repository ?? DEFAULT_REPOSITORY, options.release);
    const expectation = { kind: "fixed", stamp: stampForTag(options.release) } as const;
    checks.push(
      get(url, RELEASE_HOSTS).then((result) =>
        classifyScript(`release ${options.release}`, url, result, expectedSha, expectation),
      ),
    );
  }
  return Promise.all(checks);
}

export function exitCodeFor(reports: ReadonlyArray<SourceReport>): 0 | 1 | 2 {
  if (reports.some((report) => report.status === "mismatch")) return 1;
  if (reports.some((report) => report.status === "unreachable")) return 2;
  return 0;
}

export function formatReports(expected: Buffer, reports: ReadonlyArray<SourceReport>): string {
  const lines = [`repository ${REPO_SCRIPT_LABEL} sha256: ${sha256(expected)}`];
  for (const report of reports) {
    lines.push(`${report.label}: ${report.status.toUpperCase()} ${report.url}`, ...report.lines);
  }
  return lines.join("\n");
}

const USAGE = `Usage: bun run verify:published-remote-agent-script [--download <ref>]
  [--release v<x.y.z>] [--repository owner/repo] [--timeout-ms <ms>]

Checks that ${RETIRED_SCRIPT_URL} returns 404. With --download (latest, stable, beta, preview,
nightly or a tag), follows ${SITE_ORIGIN}/download/<ref>/remote-agent; with --release, fetches
that release's remote-agent.sh asset. Each must equal ${REPO_SCRIPT_LABEL} by SHA-256 once the
stamped DEFAULT_VERSION line is normalised, and the stamp must name the resolved release.
Exit codes: 0 as expected, 1 mismatch or disallowed redirect, 2 unreachable.`;

interface ParsedArgs {
  help: boolean;
  release?: string;
  download?: string;
  repository?: string;
  timeoutMs?: number;
}

export function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
  const parsed: ParsedArgs = { help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--help" || argument === "-h") {
      parsed.help = true;
      continue;
    }
    const [flag, inline] = argument.includes("=")
      ? [argument.slice(0, argument.indexOf("=")), argument.slice(argument.indexOf("=") + 1)]
      : [argument, undefined];
    const value = inline ?? argv[++index];
    if (value === undefined || value === "") throw new Error(`${flag} requires a value.`);
    if (flag === "--release") parsed.release = value;
    else if (flag === "--download") parsed.download = validateDownloadRef(value);
    else if (flag === "--repository") parsed.repository = value;
    else if (flag === "--timeout-ms") {
      const timeoutMs = Number(value);
      if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
        throw new Error("--timeout-ms must be an integer between 1 and 120000.");
      }
      parsed.timeoutMs = timeoutMs;
    } else throw new Error(`Unknown argument '${argument}'.\n\n${USAGE}`);
  }
  return parsed;
}

async function runCli(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  const expected = readFileSync(REPO_SCRIPT_PATH);
  const reports = await verifyPublishedRemoteAgentScript({ expected, ...args });
  console.log(formatReports(expected, reports));
  const code = exitCodeFor(reports);
  console.log(["Result: as expected.", "Result: MISMATCH.", "Result: UNREACHABLE."][code]);
  return code;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  runCli().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 2;
    },
  );
}
