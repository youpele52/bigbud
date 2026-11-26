/**
 * Idle-machine release bench for the terminal host (plan §13, Q1): the R1 screen ingest rate
 * (target ≥ 50 MiB/s per terminal) and snapshot serialisation, and the R5/R7 host RSS at 24 PTYs
 * with two snapshots in flight (target ≤ 256 MiB peak). It runs the crate's ignored release
 * benches with a clean `TMPDIR`, repeats them, parses their output and writes a JSON report.
 * macOS runs set `MallocMaxMagazines=1`, as the shipped host launch does (R7).
 *
 *   bun run --cwd apps/server benchmark:terminal-host -- --runs 3 --out bench.json
 *
 * Close other apps first: the report records the load average, and a busy machine understates
 * the ingest rate (R1 measured 34 MiB/s under load).
 *
 * @module terminalHostBench
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { cpus, loadavg, platform, release } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values: flags } = parseArgs({
  options: {
    runs: { type: "string", default: "3" },
    out: { type: "string" },
    "skip-rss": { type: "boolean", default: false },
  },
});
const runs = Math.max(1, Number(flags.runs));
const repository = resolve(import.meta.dirname, "../../..");
const out = resolve(flags.out ?? `/tmp/bigbud-terminal-bench-${Date.now()}.json`);

function cargo(args: ReadonlyArray<string>, env: NodeJS.ProcessEnv = {}) {
  const tmp = mkdtempSync("/tmp/bigbud-bench-");
  try {
    const result = spawnSync("cargo", args, {
      cwd: repository,
      encoding: "utf8",
      env: { ...process.env, TMPDIR: tmp, ...env },
      maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: result.status === 0, text: `${result.stdout}\n${result.stderr}` };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const number = (text: string, pattern: RegExp) => {
  const match = pattern.exec(text);
  return match ? Number(match[1]) : null;
};

const INGEST = [
  "test",
  "--release",
  "--locked",
  "-p",
  "bigbud-remote-agent",
  "--lib",
  "terminal_screen::tests::bench",
  "--",
  "--ignored",
  "--nocapture",
  "--test-threads=1",
];
const RSS = [
  "test",
  "--release",
  "--locked",
  "-p",
  "bigbud-remote-agent",
  "--test",
  "terminal_host_load",
  "host_rss_stays_within_256_mib_at_24_ptys_with_two_snapshots_in_flight",
  "--",
  "--ignored",
  "--nocapture",
  "--test-threads=1",
];
const hostEnv: NodeJS.ProcessEnv = platform() === "darwin" ? { MallocMaxMagazines: "1" } : {};

const before = loadavg();
console.error("building release benches…");
const build = cargo(["test", "--release", "--locked", "-p", "bigbud-remote-agent", "--no-run"]);
if (!build.ok) {
  console.error(build.text);
  process.exit(2);
}

const ingest: Array<Record<string, number | boolean | null>> = [];
const rss: Array<Record<string, number | boolean | null>> = [];
for (let run = 1; run <= runs; run++) {
  console.error(`run ${run}/${runs}: screen ingest and serialisation`);
  const screen = cargo(INGEST);
  ingest.push({
    passed: screen.ok,
    mixedMiBps: number(screen.text, /ingest mixed: ([\d.]+) MiB\/s/),
    coreSharePercentAt100KBps: number(screen.text, /\(([\d.]+)% of a core at 100 KB\/s\)/),
    rawVt100MiBps: number(screen.text, /raw vt100 ([\d.]+) MiB\/s/),
    boxDrawingMiBps: number(screen.text, /ingest box drawing and CJK: ([\d.]+) MiB\/s/),
    backgroundColourMiBps: number(screen.text, /ingest with a background colour: ([\d.]+) MiB\/s/),
  });
  if (flags["skip-rss"]) continue;
  console.error(`run ${run}/${runs}: host RSS at 24 PTYs`);
  const host = cargo(RSS, hostEnv);
  rss.push({
    passed: host.ok,
    screenModelsMiB: number(host.text, /screen models (\d+) MiB/),
    idleMiB: number(host.text, /host RSS idle (\d+) MiB/),
    peakMiB: number(host.text, /peak (\d+) MiB with/),
  });
}

const values = (rows: typeof ingest, key: string) =>
  rows.map((row) => row[key]).filter((value): value is number => typeof value === "number");
const median = (list: number[]) =>
  list.length ? list.toSorted((a, b) => a - b)[Math.floor(list.length / 2)]! : null;
const ingestMedian = median(values(ingest, "mixedMiBps"));
const peakMax = values(rss, "peakMiB").reduce<number | null>(
  (max, v) => Math.max(max ?? v, v),
  null,
);
const report = {
  kind: "bigbud-terminal-host-bench",
  at: new Date().toISOString(),
  machine: {
    platform: platform(),
    release: release(),
    cpu: cpus()[0]?.model ?? "unknown",
    cpus: cpus().length,
    loadavgBefore: before,
    loadavgAfter: loadavg(),
    idle: before[0]! < cpus().length * 0.25,
  },
  hostEnv,
  ingest,
  rss,
  criteria: {
    ingestMedianMiBps: ingestMedian,
    ingestOk: ingestMedian !== null && ingestMedian >= 50,
    rssPeakMaxMiB: peakMax,
    rssOk: flags["skip-rss"] ? null : peakMax !== null && peakMax <= 256,
  },
};
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  JSON.stringify({ out: join(out), machine: report.machine, criteria: report.criteria }, null, 2),
);
process.exit(report.criteria.ingestOk && report.criteria.rssOk !== false ? 0 : 1);
