/**
 * Terminal host soak (plan Q1 (b)) against the real binary: N terminals (default 12, 4 of them
 * agent-like TUI floods) for a configurable duration. It samples host RSS, file descriptors and
 * workspace roots, restores random terminals through fresh screen subscriptions (latency p95 and
 * cell-identical fidelity against a reference xterm.js), counts unexpected closes and
 * `modelInvalid` notices, and writes a JSON report with each Q1 criterion evaluated.
 *
 * Every terminal is reported visible, so the idle and pressure policies never close them; a
 * policy close is therefore unexpected. Restore latency is the server-side part of the §13
 * budget (subscribe to first screen item); the web parks and renders on top of it.
 *
 *   bun run --cwd apps/server soak:terminal-host -- --minutes 5
 *   bun run --cwd apps/server soak:terminal-host -- --minutes 1440 --release --out soak.json
 *
 * @module terminalHostSoak
 */
import { existsSync, writeFileSync } from "node:fs";
import { cpus, loadavg, platform, release } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { TerminalEvent } from "@bigbud/contracts";

import {
  makeHostE2eWorld,
  paneKey,
  quitIntent,
  runEffect,
  sleep,
  until,
  watchPane,
} from "../src/terminal-host/localTerminalHost.e2e.testUtils.ts";
import { median, percentile, sampleHost, type HostSample } from "./terminalHostSoak.sample.ts";
import {
  fidelityProbe,
  ReferenceScreens,
  renderScreenItem,
  seededRandom,
  tuiFloodCommand,
  visibleDiffers,
} from "./terminalHostSoak.workload.ts";

const { values: flags } = parseArgs({
  options: {
    minutes: { type: "string", default: "5" },
    terminals: { type: "string", default: "12" },
    tui: { type: "string", default: "4" },
    "sample-seconds": { type: "string", default: "15" },
    "restore-seconds": { type: "string", default: "3" },
    "warmup-minutes": { type: "string", default: "60" },
    "flood-sleep": { type: "string", default: "0.05" },
    seed: { type: "string" },
    out: { type: "string" },
    release: { type: "boolean", default: false },
  },
});
const minutes = Number(flags.minutes);
const terminalCount = Number(flags.terminals);
const tuiCount = Math.min(terminalCount, Number(flags.tui));
const sampleMs = Math.max(1_000, Number(flags["sample-seconds"]) * 1_000);
const restoreMs = Math.max(250, Number(flags["restore-seconds"]) * 1_000);
// Short runs judge growth after the first fifth instead of the first hour.
const warmupMs = Math.min(Number(flags["warmup-minutes"]), minutes / 5) * 60_000;
const seed = Number(flags.seed ?? Math.floor(Math.random() * 2 ** 31));
const random = seededRandom(seed);
const GEOMETRY = { cols: 120, rows: 32 };
const out = resolve(flags.out ?? `/tmp/bigbud-terminal-soak-${Date.now()}.json`);

if (flags.release) {
  const binary = resolve(import.meta.dirname, "../../../target/release/bigbud-remote-agent");
  if (!existsSync(binary))
    throw new Error(
      `${binary} is missing: run cargo build --release --locked -p bigbud-remote-agent`,
    );
  process.env.BIGBUD_LOCAL_WORKSPACE_AGENT_BINARY = binary;
}
process.env.BIGBUD_DEBUG_TERMINAL_HOST_STATS_MS = String(sampleMs);

const panes = Array.from({ length: terminalCount }, (_, index) => ({
  threadId: `soak-${index % 4}`,
  terminalId: `pane-${index}`,
  kind: index < tuiCount ? ("tui" as const) : ("prompt" as const),
}));
const prompts = new Set(
  panes.filter((p) => p.kind === "prompt").map((p) => paneKey(p.threadId, p.terminalId)),
);
const references = new ReferenceScreens(GEOMETRY);
const tails = new Map<string, string>();
const lastOutputAt = new Map<string, number>();
const closing = new Set<string>();
const unexpectedCloses: string[] = [];

const onEvent = (event: TerminalEvent) => {
  const key = paneKey(event.threadId, event.terminalId);
  if (event.type === "exited" && !closing.has(key)) unexpectedCloses.push(`${key} exited`);
  if (event.type !== "output" || !prompts.has(key)) return;
  references.feed(key, event.data);
  tails.set(key, ((tails.get(key) ?? "") + event.data).slice(-512));
  lastOutputAt.set(key, Date.now());
};

const world = await makeHostE2eWorld();
const startedAt = Date.now();
const samples: HostSample[] = [];
const restores: number[] = [];
const fidelity = { compared: 0, identical: 0, differingReduced: 0, differingFull: 0 };
let restoreFailures = 0;
const backend = await world.backend(
  { resolveQuitIntent: quitIntent("quit"), keepRunningAfterQuit: () => false },
  { record: false, onEvent },
);
try {
  for (const pane of panes) {
    await runEffect(backend.manager.open({ ...pane, cwd: world.cwd, ...GEOMETRY }));
    if (pane.kind === "tui")
      await runEffect(
        backend.manager.write({
          ...pane,
          data: tuiFloodCommand(GEOMETRY.rows, Number(flags["flood-sleep"])),
        }),
      );
  }
  const reportVisible = () => {
    for (const threadId of new Set(panes.map((pane) => pane.threadId)))
      backend.views.update(`soak-${threadId}`, {
        threadId,
        terminalIds: panes.filter((p) => p.threadId === threadId).map((p) => p.terminalId),
      });
  };
  reportVisible();
  const visibleTimer = setInterval(reportVisible, 10_000);
  const sample = async () => samples.push(sampleHost(world.stateDir, await world.hostPids()));
  await sample();
  const sampleTimer = setInterval(() => void sample(), sampleMs);

  const deadline = startedAt + minutes * 60_000;
  let serial = 0;
  while (Date.now() < deadline) {
    const pane = panes[Math.floor(random() * panes.length)]!;
    const key = paneKey(pane.threadId, pane.terminalId);
    try {
      if (pane.kind === "prompt") {
        const probe = fidelityProbe(random, ++serial);
        await runEffect(backend.manager.write({ ...pane, data: probe.command }));
        await until(
          () => (tails.get(key) ?? "").includes(`${probe.sentinel}\r\n`),
          "probe",
          10_000,
        );
        await until(() => Date.now() - (lastOutputAt.get(key) ?? 0) > 200, "quiet", 10_000);
      }
      const began = performance.now();
      const view = await watchPane(backend, pane.threadId, pane.terminalId);
      await until(() => view.screens.length > 0, "screen", 10_000);
      restores.push(performance.now() - began);
      const screen = view.screens[0]!;
      view.stop();
      if (pane.kind === "prompt") {
        const restored = await renderScreenItem(screen.ansi + screen.pendingEscapeTail, screen);
        const reference = await references.capture(key);
        fidelity.compared += 1;
        if (reference && !visibleDiffers(reference, restored, screen.rows)) fidelity.identical += 1;
        else if (screen.fidelity === "full") fidelity.differingFull += 1;
        else fidelity.differingReduced += 1;
      }
    } catch (cause) {
      restoreFailures += 1;
      console.error(`restore sample failed for ${key}: ${String(cause)}`);
    }
    await sleep(restoreMs);
  }
  clearInterval(sampleTimer);
  clearInterval(visibleTimer);
  await sample();
} finally {
  for (const pane of panes) closing.add(paneKey(pane.threadId, pane.terminalId));
  await backend.close().catch(() => undefined);
  references.dispose();
  await world.cleanup().catch(() => undefined);
}

const POLICY_CLOSES = new Set([
  "idleClosed",
  "pressureClosed",
  "limitClosed",
  "orphanClosed",
  "hostLost",
]);
const policyCloses = backend.notices.filter((notice) => POLICY_CLOSES.has(notice.kind));
const modelInvalid = backend.notices.filter((notice) => notice.kind === "modelInvalid").length;
const afterWarmup = samples.filter((entry) => entry.atMs - startedAt >= warmupMs);
const baseline = afterWarmup.slice(0, 3);
const final = samples.slice(-3);
const values = (rows: HostSample[], pick: (row: HostSample) => number | null) =>
  rows.map(pick).filter((value): value is number => value !== null);
const rssBase = median(values(baseline, (row) => row.rssKiB));
const rssFinal = median(values(final, (row) => row.rssKiB));
const growth = rssBase && rssFinal ? (100 * (rssFinal - rssBase)) / rssBase : null;
const grew = (pick: (row: HostSample) => number | null, tolerance: number) => {
  const base = median(values(baseline, pick));
  const end = median(values(final, pick));
  return base === null || end === null ? null : end > base + tolerance;
};
const restoreP95 = percentile(restores, 95);
const criteria = {
  rssGrowthPercent: growth,
  rssGrowthOk: growth !== null && growth <= 10,
  fdGrowth: grew((row) => row.fds, 4),
  workspaceRootGrowth: grew((row) => row.workspaceRoots, 0),
  unexpectedCloses: unexpectedCloses.length + policyCloses.length,
  modelInvalid,
  restoreP95Ms: restoreP95,
  restoreP95Ok: restoreP95 !== null && restoreP95 <= 150,
  fidelityIdenticalPercent: fidelity.compared
    ? (100 * fidelity.identical) / fidelity.compared
    : null,
  fidelityOk:
    fidelity.compared > 0 &&
    fidelity.identical >= fidelity.compared * 0.995 &&
    fidelity.differingFull === 0,
};
const pass =
  criteria.rssGrowthOk &&
  criteria.fdGrowth === false &&
  criteria.workspaceRootGrowth === false &&
  criteria.unexpectedCloses === 0 &&
  modelInvalid === 0 &&
  criteria.restoreP95Ok &&
  criteria.fidelityOk;
const report = {
  kind: "bigbud-terminal-host-soak",
  startedAt: new Date(startedAt).toISOString(),
  durationMinutes: (Date.now() - startedAt) / 60_000,
  machine: { platform: platform(), release: release(), cpus: cpus().length, loadavg: loadavg() },
  config: {
    minutes,
    terminalCount,
    tuiCount,
    sampleMs,
    restoreMs,
    warmupMs,
    seed,
    geometry: GEOMETRY,
    release: flags.release,
    binary: process.env.BIGBUD_LOCAL_WORKSPACE_AGENT_BINARY ?? "target/debug",
  },
  rssKiB: {
    first: samples[0]?.rssKiB ?? null,
    afterWarmup: rssBase,
    final: rssFinal,
    peak: Math.max(0, ...samples.map((row) => row.rssKiB)),
  },
  restoreMs: {
    count: restores.length,
    failures: restoreFailures,
    p50: median(restores),
    p95: restoreP95,
    max: restores.length ? Math.max(...restores) : null,
  },
  fidelity,
  unexpectedCloses: [
    ...unexpectedCloses,
    ...policyCloses.map((notice) => `${notice.threadId}/${notice.terminalId} ${notice.kind}`),
  ],
  notices: Object.fromEntries(
    [...new Set(backend.notices.map((n) => n.kind))].map((kind) => [
      kind,
      backend.notices.filter((n) => n.kind === kind).length,
    ]),
  ),
  criteria,
  pass,
  samples,
};
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      out: join(out),
      pass,
      criteria,
      rssKiB: report.rssKiB,
      restoreMs: report.restoreMs,
      fidelity,
    },
    null,
    2,
  ),
);
process.exit(pass ? 0 : 1);
