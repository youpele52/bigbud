/**
 * Server test shard coverage: proves that every file `vitest list --filesOnly` expects ran exactly
 * once across the CI test jobs (the `unit` job and the `integration` shards).
 *
 * Pure logic only (parsing, path normalisation, diffing and totals). File IO, the step summary and
 * the exit code live in `scripts/verify-test-shard-coverage.ts`.
 */

export type ServerTestProject = "unit" | "integration";

export interface ExpectedTestFile {
  /** Path relative to the package directory, with forward slashes. */
  readonly path: string;
  readonly project: ServerTestProject;
}

export interface TestTotals {
  readonly files: number;
  /** Files whose every test was skipped or todo; they still count as having run. */
  readonly skippedOnlyFiles: number;
  readonly failedFiles: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly todo: number;
}

export interface ReportFile {
  /** Path as written by the reporter (absolute, runner-specific). */
  readonly rawPath: string;
  readonly failed: boolean;
  readonly skippedOnly: boolean;
}

export interface ParsedTestReport {
  readonly files: ReadonlyArray<ReportFile>;
  readonly totals: TestTotals;
}

export interface ShardCoverageInput {
  readonly expected: ReadonlyArray<ExpectedTestFile>;
  /** `undefined` when the unit report is missing. */
  readonly unit: ParsedTestReport | undefined;
  /** Integration shard reports keyed by their 1-based shard index. */
  readonly shards: ReadonlyMap<number, ParsedTestReport>;
  readonly shardCount: number;
  readonly packageDir: string;
}

export interface ShardCoverageResult {
  readonly problems: ReadonlyArray<string>;
  /** One row per report that was read, in order: `unit`, then `integration-1..N`. */
  readonly rows: ReadonlyArray<readonly [label: string, totals: TestTotals]>;
  readonly total: TestTotals;
  readonly expectedCounts: Readonly<Record<ServerTestProject, number>>;
}

export interface ShardCoverageArgs {
  readonly expected: string;
  readonly unit: string;
  readonly shardsDir: string;
  readonly shardCount: number;
  readonly packageDir: string;
}

export const SHARD_COVERAGE_USAGE =
  "Usage: node scripts/verify-test-shard-coverage.ts --expected <vitest list JSON> --unit <unit report> " +
  "--shards-dir <dir with integration-<i>.json> --shard-count <N> --package-dir <dir, e.g. apps/server>";

/** Parses `--flag value` pairs. Every flag is required, so CI states each input explicitly. */
export function parseShardCoverageArgs(argv: ReadonlyArray<string>): ShardCoverageArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]!;
    const value = argv[index + 1];
    if (!flag.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`Expected '--flag value' pairs near '${flag}'.\n${SHARD_COVERAGE_USAGE}`);
    }
    values.set(flag.slice(2), value);
  }
  const known = new Set(["expected", "unit", "shards-dir", "shard-count", "package-dir"]);
  const unknown = [...values.keys()].filter((key) => !known.has(key));
  if (unknown.length > 0) throw new Error(`Unknown flag(s): ${unknown.join(", ")}.`);
  const required = (key: string) => {
    const value = values.get(key);
    if (!value) throw new Error(`Missing --${key}.\n${SHARD_COVERAGE_USAGE}`);
    return value;
  };
  const shardCountText = required("shard-count");
  const shardCount = Number(shardCountText);
  if (!/^\d+$/.test(shardCountText) || shardCount < 1) {
    throw new Error(`--shard-count must be a positive integer, got '${shardCountText}'.`);
  }
  return {
    expected: required("expected"),
    unit: required("unit"),
    shardsDir: required("shards-dir"),
    shardCount,
    packageDir: required("package-dir"),
  };
}

const PROJECTS: ReadonlyArray<ServerTestProject> = ["unit", "integration"];
const SHARD_REPORT_NAME = /^integration-(\d+)\.json$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The path after `<packageDir>/`, with forward slashes, so reports written under different runner
 * roots (or on Windows) compare equal. `undefined` when the path is outside the package.
 */
export function normalizeTestPath(path: string, packageDir: string): string | undefined {
  const dir = packageDir.replace(/\\/g, "/").replace(/^\.?\/+|\/+$/g, "");
  const marker = `/${dir}/`;
  const slashed = `/${path.replace(/\\/g, "/").replace(/^\/+/, "")}`;
  const index = slashed.indexOf(marker);
  return index === -1 ? undefined : slashed.slice(index + marker.length);
}

/** The 1-based shard index of an `integration-<i>.json` report name, or `undefined`. */
export function shardIndexOfReportName(name: string): number | undefined {
  const match = SHARD_REPORT_NAME.exec(name);
  return match ? Number(match[1]) : undefined;
}

/** Parses `vitest list --filesOnly --json` output (`[{ file, projectName }]`). */
export function parseExpectedFileList(
  value: unknown,
  packageDir: string,
): ReadonlyArray<ExpectedTestFile> {
  if (!Array.isArray(value)) throw new Error("Expected file list is not a JSON array.");
  return value.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.file !== "string") {
      throw new Error(`Expected file list entry ${index} has no string 'file'.`);
    }
    const project = entry.projectName;
    if (project !== "unit" && project !== "integration") {
      throw new Error(`Expected file list entry ${entry.file} has unknown project '${project}'.`);
    }
    const path = normalizeTestPath(entry.file, packageDir);
    if (path === undefined)
      throw new Error(`Expected file ${entry.file} is outside ${packageDir}.`);
    return { path, project };
  });
}

/** Parses a Vitest JSON reporter file (one `testResults` entry per test module). */
export function parseVitestJsonReport(value: unknown, label: string): ParsedTestReport {
  if (!isRecord(value) || !Array.isArray(value.testResults)) {
    throw new Error(`${label} is not a Vitest JSON report (no 'testResults' array).`);
  }
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let todo = 0;
  const files = value.testResults.map((result, index): ReportFile => {
    if (!isRecord(result) || typeof result.name !== "string") {
      throw new Error(`${label} testResults[${index}] has no string 'name'.`);
    }
    const assertions = Array.isArray(result.assertionResults) ? result.assertionResults : [];
    let fileFailed = result.status === "failed";
    let ran = 0;
    for (const assertion of assertions) {
      const status = isRecord(assertion) ? assertion.status : undefined;
      if (status === "passed") {
        passed += 1;
        ran += 1;
      } else if (status === "failed") {
        failed += 1;
        ran += 1;
        fileFailed = true;
      } else if (status === "todo") todo += 1;
      else skipped += 1;
    }
    return { rawPath: result.name, failed: fileFailed, skippedOnly: ran === 0 && !fileFailed };
  });
  return {
    files,
    totals: {
      files: files.length,
      skippedOnlyFiles: files.filter((file) => file.skippedOnly).length,
      failedFiles: files.filter((file) => file.failed).length,
      passed,
      failed,
      skipped,
      todo,
    },
  };
}

const EMPTY_TOTALS: TestTotals = {
  files: 0,
  skippedOnlyFiles: 0,
  failedFiles: 0,
  passed: 0,
  failed: 0,
  skipped: 0,
  todo: 0,
};

function addTotals(left: TestTotals, right: TestTotals): TestTotals {
  return {
    files: left.files + right.files,
    skippedOnlyFiles: left.skippedOnlyFiles + right.skippedOnlyFiles,
    failedFiles: left.failedFiles + right.failedFiles,
    passed: left.passed + right.passed,
    failed: left.failed + right.failed,
    skipped: left.skipped + right.skipped,
    todo: left.todo + right.todo,
  };
}

const listed = (paths: ReadonlyArray<string>) => paths.map((path) => `\n  - ${path}`).join("");

/** Compares the reports with the expected file list. An empty `problems` list means full cover. */
export function checkShardCoverage(input: ShardCoverageInput): ShardCoverageResult {
  const problems: string[] = [];
  const expectedProject = new Map(input.expected.map((file) => [file.path, file.project]));
  const expectedCounts = { unit: 0, integration: 0 };
  for (const file of input.expected) expectedCounts[file.project] += 1;

  if (!Number.isInteger(input.shardCount) || input.shardCount < 1) {
    problems.push(`Shard count must be a positive integer, got ${input.shardCount}.`);
  }
  const reports: Array<[label: string, project: ServerTestProject, report: ParsedTestReport]> = [];
  if (input.unit === undefined) problems.push("The unit report is missing.");
  else reports.push(["unit", "unit", input.unit]);
  for (let index = 1; index <= input.shardCount; index += 1) {
    const report = input.shards.get(index);
    if (report === undefined) problems.push(`The integration shard ${index} report is missing.`);
    else reports.push([`integration-${index}`, "integration", report]);
  }
  for (const index of [...input.shards.keys()].toSorted((a, b) => a - b)) {
    if (index < 1 || index > input.shardCount) {
      problems.push(
        `Unexpected integration shard report ${index} (shard count ${input.shardCount}).`,
      );
    }
  }

  // Where each expected file ran, per project.
  const ranIn = new Map<string, string[]>();
  const outside: string[] = [];
  const unexpected: string[] = [];
  const wrongProject: string[] = [];
  const failedFiles: string[] = [];
  for (const [label, project, report] of reports) {
    for (const file of report.files) {
      const path = normalizeTestPath(file.rawPath, input.packageDir);
      if (path === undefined) {
        outside.push(`${file.rawPath} (${label})`);
        continue;
      }
      if (file.failed) failedFiles.push(`${path} (${label})`);
      const expected = expectedProject.get(path);
      if (expected === undefined) unexpected.push(`${path} (${label})`);
      else if (expected !== project) wrongProject.push(`${path} (${label}, expected ${expected})`);
      else ranIn.set(path, [...(ranIn.get(path) ?? []), label]);
    }
  }

  const missing: Record<ServerTestProject, string[]> = { unit: [], integration: [] };
  const duplicated: string[] = [];
  for (const file of input.expected) {
    const labels = ranIn.get(file.path) ?? [];
    if (labels.length === 0) missing[file.project].push(file.path);
    else if (labels.length > 1) duplicated.push(`${file.path} (${labels.join(", ")})`);
  }

  const report = (paths: ReadonlyArray<string>, message: string) => {
    if (paths.length > 0) problems.push(`${message} (${paths.length}):${listed(paths)}`);
  };
  for (const project of PROJECTS) {
    report(missing[project], `Expected ${project} files missing from every ${project} report`);
  }
  report(duplicated, "Files that ran more than once");
  report(unexpected, "Files in a report that vitest list does not expect");
  report(wrongProject, "Files reported under the wrong project");
  report(outside, `Files outside ${input.packageDir}`);
  report(failedFiles, "Files with failures");

  const rows = reports.map(([label, , parsed]) => [label, parsed.totals] as const);
  const total = rows.reduce((sum, [, totals]) => addTotals(sum, totals), EMPTY_TOTALS);
  return { problems, rows, total, expectedCounts };
}

const TOTALS_HEADER =
  "| Report | Files | Skipped-only files | Failed files | Passed | Failed | Skipped | Todo |";

const totalsRow = (label: string, totals: TestTotals) =>
  `| ${label} | ${totals.files} | ${totals.skippedOnlyFiles} | ${totals.failedFiles} | ${totals.passed} | ${totals.failed} | ${totals.skipped} | ${totals.todo} |`;

/** Markdown for the step summary and the log. */
export function formatShardCoverageSummary(result: ShardCoverageResult): string {
  const { expectedCounts } = result;
  const verdict =
    result.problems.length === 0
      ? "Every expected server test file ran exactly once."
      : `Coverage check failed with ${result.problems.length} problem(s).`;
  const lines = [
    "### Server test shard coverage",
    "",
    verdict,
    "",
    `Expected files: ${expectedCounts.unit + expectedCounts.integration} (unit ${expectedCounts.unit}, integration ${expectedCounts.integration}).`,
    "",
    TOTALS_HEADER,
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...result.rows.map(([label, totals]) => totalsRow(label, totals)),
    totalsRow("**Total**", result.total),
  ];
  if (result.problems.length > 0) {
    lines.push("", "#### Problems", "", ...result.problems.map((problem) => `- ${problem}`));
  }
  return `${lines.join("\n")}\n`;
}
