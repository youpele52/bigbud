/**
 * Regenerate `apps/server/vitest.unit-files.txt`, the list of server test files
 * that run in the parallel `unit` Vitest project.
 *
 *   bun run --cwd apps/server test:groups                  # probe every test file
 *   bun run --cwd apps/server test:groups -- src/git       # re-probe matching files only
 *   bun run --cwd apps/server test:groups -- --runs 3      # require 3 clean runs
 *   bun run --cwd apps/server test:groups -- --report /tmp/groups.json  # keep per-file details
 *
 * The probe runs the selected files in parallel under the guard in record mode
 * (see `serverTestGroups.guard.ts`). A file is listed only when, in every run,
 * all of its tests pass and it touches no serial-only resource. Failing under
 * parallel load also keeps a file serial. Files under `integration/` are never
 * listed. Files skipped in this environment stay serial, because they may
 * touch real resources where they do run. When paths are given, only the
 * probed files change in the list.
 */
import { spawnSync } from "node:child_process";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { classifyTestFileRun, type TestFileResult } from "./serverTestGroups.classification.ts";
import { PROBE_OUTPUT_ENV, type ProbeRecord, type Touch } from "./serverTestGroups.guard.types.ts";
import {
  isParallelCandidate,
  readParallelTestFiles,
  writeParallelTestFiles,
} from "./serverTestGroups.manifest.ts";

interface JsonReport {
  readonly testResults: ReadonlyArray<TestFileResult & { readonly name: string }>;
}

const serverRoot = Path.resolve(import.meta.dirname, "..");
const relative = (file: string) => Path.relative(serverRoot, file).split(Path.sep).join("/");

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const optionValue = (name: string) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args.splice(index, 2)[1];
};
const runs = Number(optionValue("--runs") ?? 1);
const reportPath = optionValue("--report");
const filters = args;
if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");

interface FileVerdict {
  readonly file: string;
  /** Per-run classification; incomplete assertions and missing probes never count as passed. */
  readonly statuses: string[];
  readonly touches: Touch[];
}

function probeOnce(run: number, verdicts: Map<string, FileVerdict>): void {
  const workDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "bigbud-test-groups-"));
  const probeFile = Path.join(workDir, "probe.jsonl");
  const reportFile = Path.join(workDir, "report.json");
  console.log(`\n[test:groups] probe run ${run}/${runs} ${filters.join(" ")}`);
  spawnSync(
    "bun",
    ["run", "vitest", "run", ...filters, "--reporter=dot", "--reporter=json"].concat(
      `--outputFile.json=${reportFile}`,
    ),
    { cwd: serverRoot, stdio: "inherit", env: { ...process.env, [PROBE_OUTPUT_ENV]: probeFile } },
  );
  if (!FS.existsSync(reportFile)) throw new Error(`Vitest did not write ${reportFile}`);
  const report = JSON.parse(FS.readFileSync(reportFile, "utf8")) as JsonReport;
  const probes = new Map<string, ProbeRecord>();
  if (FS.existsSync(probeFile)) {
    for (const line of FS.readFileSync(probeFile, "utf8").split("\n")) {
      if (line.trim().length === 0) continue;
      const record = JSON.parse(line) as ProbeRecord;
      probes.set(record.file, record);
    }
  }
  for (const result of report.testResults) {
    const file = relative(result.name);
    const verdict = verdicts.get(file) ?? { file, statuses: [], touches: [] };
    const probe = probes.get(file);
    verdict.statuses.push(classifyTestFileRun(result, probe));
    verdict.touches.push(...(probe?.touches ?? []));
    verdicts.set(file, verdict);
  }
  FS.rmSync(workDir, { recursive: true, force: true });
}

const verdicts = new Map<string, FileVerdict>();
for (let run = 1; run <= runs; run += 1) probeOnce(run, verdicts);

// Parallel only when every run passed and nothing serial-only was touched.
const isSafe = (verdict: FileVerdict) =>
  verdict.statuses.length === runs &&
  verdict.statuses.every((status) => status === "passed") &&
  verdict.touches.length === 0 &&
  isParallelCandidate(verdict.file);

const safe = new Set<string>();
const touchedKinds = new Map<string, number>();
const notPassed = new Map<string, string[]>();
for (const verdict of verdicts.values()) {
  for (const kind of new Set(verdict.touches.map((touch) => touch.kind))) {
    touchedKinds.set(kind, (touchedKinds.get(kind) ?? 0) + 1);
  }
  for (const status of new Set(verdict.statuses.filter((status) => status !== "passed"))) {
    notPassed.set(status, [...(notPassed.get(status) ?? []), verdict.file]);
  }
  if (isSafe(verdict)) safe.add(verdict.file);
}

const previous = new Set(readParallelTestFiles(serverRoot));
const next = new Set(filters.length === 0 ? [] : previous);
for (const file of verdicts.keys()) next.delete(file);
for (const file of safe) next.add(file);
writeParallelTestFiles(serverRoot, next);
if (reportPath !== undefined) {
  FS.writeFileSync(reportPath, `${JSON.stringify([...verdicts.values()], null, 2)}\n`);
}

const added = [...next].filter((file) => !previous.has(file));
const removed = [...previous].filter((file) => !next.has(file));
console.log(`\n[test:groups] probed ${verdicts.size} files over ${runs} run(s)`);
console.log(
  `[test:groups] parallel (unit): ${next.size} files (+${added.length} -${removed.length})`,
);
for (const [kind, count] of [...touchedKinds].toSorted((a, b) => b[1] - a[1])) {
  console.log(`[test:groups]   serial because of ${kind}: ${count} files`);
}
for (const [status, files] of notPassed) {
  console.log(`[test:groups]   serial because a run was ${status}: ${files.length} files`);
  if (status !== "skipped") for (const file of files.toSorted()) console.log(`    - ${file}`);
}
for (const file of removed.toSorted()) console.log(`[test:groups] moved to serial: ${file}`);
