#!/usr/bin/env node
/**
 * CI check: every server test file that `vitest list --filesOnly` expects ran exactly once across
 * the `unit` report and the `integration-<i>.json` shard reports. Reads the shard directory
 * non-recursively (the CI job downloads every report into one flat directory). Writes the totals to
 * `$GITHUB_STEP_SUMMARY` when set and exits 1 on any coverage problem.
 */
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  checkShardCoverage,
  formatShardCoverageSummary,
  parseExpectedFileList,
  parseShardCoverageArgs,
  parseVitestJsonReport,
  shardIndexOfReportName,
} from "./lib/test-shard-coverage.ts";
import type { ParsedTestReport } from "./lib/test-shard-coverage.ts";

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

const args = parseShardCoverageArgs(process.argv.slice(2));
const expected = parseExpectedFileList(readJson(args.expected), args.packageDir);
const unit = existsSync(args.unit)
  ? parseVitestJsonReport(readJson(args.unit), args.unit)
  : undefined;

const shards = new Map<number, ParsedTestReport>();
for (const entry of readdirSync(args.shardsDir, { withFileTypes: true })) {
  const index = entry.isFile() ? shardIndexOfReportName(entry.name) : undefined;
  if (index === undefined) continue;
  const path = join(args.shardsDir, entry.name);
  shards.set(index, parseVitestJsonReport(readJson(path), path));
}

const result = checkShardCoverage({
  expected,
  unit,
  shards,
  shardCount: args.shardCount,
  packageDir: args.packageDir,
});
const summary = formatShardCoverageSummary(result);
console.log(summary);
const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (summaryPath) appendFileSync(summaryPath, summary);
if (result.problems.length > 0) process.exitCode = 1;
