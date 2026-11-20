import { describe, expect, it } from "vitest";

import {
  checkShardCoverage,
  formatShardCoverageSummary,
  normalizeTestPath,
  parseExpectedFileList,
  parseShardCoverageArgs,
  parseVitestJsonReport,
  shardIndexOfReportName,
} from "./test-shard-coverage";
import type { ParsedTestReport, ShardCoverageInput } from "./test-shard-coverage";

const PACKAGE_DIR = "apps/server";
const LOCAL_ROOT = "/Users/dev/bigbud/apps/server";
const RUNNER_ROOT = "/home/runner/work/bigbud/bigbud/apps/server";

const EXPECTED = parseExpectedFileList(
  [
    { file: `${LOCAL_ROOT}/src/a.test.ts`, projectName: "unit" },
    { file: `${LOCAL_ROOT}/src/b.test.ts`, projectName: "integration" },
    { file: `${LOCAL_ROOT}/src/c.test.ts`, projectName: "integration" },
    { file: `${LOCAL_ROOT}/scripts/d.test.ts`, projectName: "integration" },
  ],
  PACKAGE_DIR,
);

type Status = "passed" | "failed" | "skipped" | "pending" | "todo";

/** A Vitest JSON report written on a CI runner: one module per path with the given statuses. */
function report(files: Record<string, ReadonlyArray<Status>>): ParsedTestReport {
  return parseVitestJsonReport(
    {
      testResults: Object.entries(files).map(([path, statuses]) => ({
        name: `${RUNNER_ROOT}/${path}`,
        status: statuses.includes("failed") ? "failed" : "passed",
        assertionResults: statuses.map((status) => ({ status })),
      })),
    },
    "test report",
  );
}

function input(overrides: Partial<ShardCoverageInput> = {}): ShardCoverageInput {
  return {
    expected: EXPECTED,
    unit: report({ "src/a.test.ts": ["passed"] }),
    shards: new Map([
      [1, report({ "src/b.test.ts": ["passed", "passed"] })],
      [2, report({ "src/c.test.ts": ["passed"], "scripts/d.test.ts": ["passed"] })],
    ]),
    shardCount: 2,
    packageDir: PACKAGE_DIR,
    ...overrides,
  };
}

const problemsOf = (overrides: Partial<ShardCoverageInput>) =>
  checkShardCoverage(input(overrides)).problems.join("\n");

describe("server test shard coverage", () => {
  it("passes an exact cover and totals every report", () => {
    const result = checkShardCoverage(input());
    expect(result.problems).toEqual([]);
    expect(result.expectedCounts).toEqual({ unit: 1, integration: 3 });
    expect(result.rows.map(([label]) => label)).toEqual(["unit", "integration-1", "integration-2"]);
    expect(result.total).toMatchObject({ files: 4, passed: 5, failed: 0, skipped: 0, todo: 0 });
  });

  it("fails when an expected integration file ran in no shard", () => {
    const shards = new Map([
      [1, report({ "src/b.test.ts": ["passed"] })],
      [2, report({})],
    ]);
    const problems = problemsOf({ shards });
    expect(problems).toContain(
      "Expected integration files missing from every integration report (2)",
    );
    expect(problems).toContain("src/c.test.ts");
    expect(problems).toContain("scripts/d.test.ts");
  });

  it("fails when an expected unit file is missing from the unit report", () => {
    expect(problemsOf({ unit: report({}) })).toContain(
      "Expected unit files missing from every unit report (1):\n  - src/a.test.ts",
    );
  });

  it("fails when a file ran in more than one shard", () => {
    const shards = new Map([
      [1, report({ "src/b.test.ts": ["passed"], "src/c.test.ts": ["passed"] })],
      [2, report({ "src/c.test.ts": ["passed"], "scripts/d.test.ts": ["passed"] })],
    ]);
    expect(problemsOf({ shards })).toContain(
      "Files that ran more than once (1):\n  - src/c.test.ts (integration-1, integration-2)",
    );
  });

  it("fails on a file that vitest list does not expect", () => {
    const unit = report({ "src/a.test.ts": ["passed"], "src/new.test.ts": ["passed"] });
    expect(problemsOf({ unit })).toContain(
      "Files in a report that vitest list does not expect (1):\n  - src/new.test.ts (unit)",
    );
  });

  it("fails when a unit file runs in a shard or an integration file in the unit job", () => {
    const shards = new Map([
      [1, report({ "src/b.test.ts": ["passed"], "src/a.test.ts": ["passed"] })],
      [2, report({ "src/c.test.ts": ["passed"], "scripts/d.test.ts": ["passed"] })],
    ]);
    const unit = report({ "src/a.test.ts": ["passed"], "src/b.test.ts": ["passed"] });
    const problems = problemsOf({ shards, unit });
    expect(problems).toContain("Files reported under the wrong project (2)");
    expect(problems).toContain("src/a.test.ts (integration-1, expected unit)");
    expect(problems).toContain("src/b.test.ts (unit, expected integration)");
  });

  it("fails when a shard report or the unit report is missing", () => {
    const shards = new Map([[1, report({ "src/b.test.ts": ["passed"] })]]);
    const problems = checkShardCoverage(input({ shards, unit: undefined })).problems;
    expect(problems).toContain("The unit report is missing.");
    expect(problems).toContain("The integration shard 2 report is missing.");
  });

  it("fails on a shard report beyond the shard count", () => {
    const shards = new Map(input().shards);
    shards.set(3, report({}));
    expect(problemsOf({ shards })).toContain(
      "Unexpected integration shard report 3 (shard count 2).",
    );
  });

  it("counts a skipped-only file as having run", () => {
    const shards = new Map([
      [1, report({ "src/b.test.ts": ["skipped", "pending"] })],
      [2, report({ "src/c.test.ts": ["todo"], "scripts/d.test.ts": ["passed", "skipped"] })],
    ]);
    const result = checkShardCoverage(input({ shards }));
    expect(result.problems).toEqual([]);
    expect(result.total).toMatchObject({ files: 4, skippedOnlyFiles: 2, skipped: 3, todo: 1 });
  });

  it("reports files with failures", () => {
    const shards = new Map(input().shards);
    shards.set(1, report({ "src/b.test.ts": ["passed", "failed"] }));
    const result = checkShardCoverage(input({ shards }));
    expect(result.problems.join("\n")).toContain(
      "Files with failures (1):\n  - src/b.test.ts (integration-1)",
    );
    expect(result.total).toMatchObject({ failed: 1, failedFiles: 1 });
  });

  it("fails on a reported path outside the package directory", () => {
    const unit = parseVitestJsonReport(
      { testResults: [{ name: "/elsewhere/a.test.ts", status: "passed", assertionResults: [] }] },
      "unit",
    );
    expect(problemsOf({ unit })).toContain("Files outside apps/server (1)");
  });

  it("writes a summary with the verdict, totals and problems", () => {
    expect(formatShardCoverageSummary(checkShardCoverage(input()))).toContain(
      "Every expected server test file ran exactly once.",
    );
    const failing = formatShardCoverageSummary(checkShardCoverage(input({ unit: undefined })));
    expect(failing).toContain("Coverage check failed with 2 problem(s).");
    expect(failing).toContain("| **Total** | 3 | 0 | 0 | 4 | 0 | 0 | 0 |");
    expect(failing).toContain("- The unit report is missing.");
  });
});

describe("server test report paths and inputs", () => {
  it("normalises paths from different roots and separators to the package suffix", () => {
    expect(normalizeTestPath(`${LOCAL_ROOT}/src/x.test.ts`, PACKAGE_DIR)).toBe("src/x.test.ts");
    expect(normalizeTestPath(`${RUNNER_ROOT}/src/x.test.ts`, "./apps/server/")).toBe(
      "src/x.test.ts",
    );
    expect(normalizeTestPath("D:\\a\\bigbud\\apps\\server\\src\\x.test.ts", PACKAGE_DIR)).toBe(
      "src/x.test.ts",
    );
    expect(normalizeTestPath("/repo/apps/web/src/x.test.ts", PACKAGE_DIR)).toBeUndefined();
  });

  it("reads shard indexes only from integration-<i>.json names", () => {
    expect(shardIndexOfReportName("integration-3.json")).toBe(3);
    expect(shardIndexOfReportName("unit.json")).toBeUndefined();
    expect(shardIndexOfReportName("integration-3.json.bak")).toBeUndefined();
  });

  it("rejects malformed expected lists and reports", () => {
    expect(() => parseExpectedFileList({}, PACKAGE_DIR)).toThrow("not a JSON array");
    expect(() =>
      parseExpectedFileList([{ file: `${LOCAL_ROOT}/a.test.ts`, projectName: "e2e" }], PACKAGE_DIR),
    ).toThrow("unknown project 'e2e'");
    expect(() => parseVitestJsonReport({ numTotalTests: 0 }, "unit.json")).toThrow(
      "unit.json is not a Vitest JSON report",
    );
  });

  it("parses every required flag and rejects missing or invalid ones", () => {
    const argv = [
      ["--expected", "e.json"],
      ["--unit", "r/unit.json"],
      ["--shards-dir", "r"],
      ["--shard-count", "8"],
      ["--package-dir", PACKAGE_DIR],
    ].flat();
    expect(parseShardCoverageArgs(argv)).toEqual({
      expected: "e.json",
      unit: "r/unit.json",
      shardsDir: "r",
      shardCount: 8,
      packageDir: PACKAGE_DIR,
    });
    expect(() => parseShardCoverageArgs(argv.slice(2))).toThrow("Missing --expected");
    expect(() => parseShardCoverageArgs([...argv.slice(0, 7), "0", ...argv.slice(8)])).toThrow(
      "--shard-count must be a positive integer",
    );
    expect(() => parseShardCoverageArgs([...argv, "--shard", "1"])).toThrow("Unknown flag(s)");
    expect(() => parseShardCoverageArgs(["--expected"])).toThrow("'--flag value' pairs");
  });
});
