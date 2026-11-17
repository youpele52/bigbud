/**
 * Checks that the published remote-agent staging script matches the repository copy (D3: the
 * site serves `apps/marketing/public/remote-agent.sh`, never the moving main branch).
 *
 * Exit codes: 0 every source matches, 1 any source differs or is served from a disallowed
 * location (including oversize content), 2 a source could not be fetched and none differed.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { boundedHttpsGet, type BoundedFetchResult } from "./lib/bounded-https-fetch.ts";

export const PUBLISHED_SCRIPT_URL = "https://bigbud.app/remote-agent.sh";
export const DEFAULT_REPOSITORY = "youpele52/bigbud";
export const DEFAULT_TIMEOUT_MS = 15_000;
/** The repo script is a few KiB; anything past this cannot be it. */
export const MAX_SCRIPT_BYTES = 256 * 1024;
const REPO_SCRIPT_PATH = fileURLToPath(
  new URL("../apps/marketing/public/remote-agent.sh", import.meta.url),
);

export const SITE_HOSTS: ReadonlySet<string> = new Set(["bigbud.app", "www.bigbud.app"]);
export const RELEASE_HOSTS: ReadonlySet<string> = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);
const RAW_GITHUB_HOST = "raw.githubusercontent.com";

export type SourceStatus = "match" | "mismatch" | "unreachable";

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
  readonly repository?: string;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly siteUrl?: string;
}

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

function classify(
  label: string,
  url: string,
  result: BoundedFetchResult,
  expectedSha: string,
): SourceReport {
  switch (result.kind) {
    case "ok": {
      const actual = sha256(result.bytes);
      const via = result.hops.length > 1 ? [`  via: ${result.hops.join(" -> ")}`] : [];
      const lines = [`  sha256: ${actual} (${result.bytes.length} bytes)`, ...via];
      const mismatch = [...lines, `  expected: ${expectedSha}`];
      return actual === expectedSha
        ? { label, url, status: "match", lines }
        : { label, url, status: "mismatch", lines: [...mismatch, ...mismatchHints(result)] };
    }
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
  }
}

function mismatchHints(result: { bytes: Buffer; contentType: string }): string[] {
  const head = result.bytes.subarray(0, 512).toString("utf8").trimStart().toLowerCase();
  if (!result.contentType.includes("text/html") && !/^<(!doctype html|html)/.test(head)) return [];
  return [
    `  served ${result.contentType || "HTML"}: likely the site's fallback page,`,
    "  so remote-agent.sh is not deployed at this URL.",
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
  const sources: Array<{ label: string; url: string; hosts: ReadonlySet<string> }> = [
    { label: "site", url: options.siteUrl ?? PUBLISHED_SCRIPT_URL, hosts: SITE_HOSTS },
  ];
  if (options.release) {
    const url = releaseScriptUrl(options.repository ?? DEFAULT_REPOSITORY, options.release);
    sources.push({ label: `release ${options.release}`, url, hosts: RELEASE_HOSTS });
  }
  return Promise.all(
    sources.map(async ({ label, url, hosts }) =>
      classify(
        label,
        url,
        await boundedHttpsGet(url, { ...fetchOptions, allowedHosts: hosts }),
        expectedSha,
      ),
    ),
  );
}

export function exitCodeFor(reports: ReadonlyArray<SourceReport>): 0 | 1 | 2 {
  if (reports.some((report) => report.status === "mismatch")) return 1;
  if (reports.some((report) => report.status === "unreachable")) return 2;
  return 0;
}

export function formatReports(expected: Buffer, reports: ReadonlyArray<SourceReport>): string {
  const lines = [`repository apps/marketing/public/remote-agent.sh sha256: ${sha256(expected)}`];
  for (const report of reports) {
    lines.push(`${report.label}: ${report.status.toUpperCase()} ${report.url}`, ...report.lines);
  }
  return lines.join("\n");
}

const USAGE = `Usage: bun run verify:published-remote-agent-script [--release v<x.y.z>]
  [--repository owner/repo] [--timeout-ms <ms>]

Compares ${PUBLISHED_SCRIPT_URL} (and, with --release, that release's remote-agent.sh asset)
to apps/marketing/public/remote-agent.sh by SHA-256.
Exit codes: 0 match, 1 mismatch or disallowed redirect, 2 unreachable.`;

export function parseArgs(argv: ReadonlyArray<string>): {
  help: boolean;
  release?: string;
  repository?: string;
  timeoutMs?: number;
} {
  const parsed: { help: boolean; release?: string; repository?: string; timeoutMs?: number } = {
    help: false,
  };
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
  console.log(["Result: match.", "Result: MISMATCH.", "Result: UNREACHABLE."][code]);
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
