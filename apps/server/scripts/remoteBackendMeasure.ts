/**
 * Remote backend measurement (WP-6A, P7 increment 6). Run it on the backend host as the
 * backend's own account, with the graph's private Node (type stripping, no dependencies):
 *
 *   ~/runtime/backend/runtime/node remoteBackendMeasure.ts --authority <id> [options]
 *
 * Without `--fake-provider` it only observes: `/proc`, unit PIDs, database file sizes, the
 * handshake and read-only RPCs. With `--fake-provider` it also creates one disposable project
 * and its threads (all named `bigbud-measure-*`), points the Codex provider at a fake
 * app-server for the duration, and deletes everything and restores the Codex settings at the
 * end. It also writes `~/bigbud-measure-work-<time>/` (the fake's wrapper, the project
 * folder and a restore journal), removed only when cleanup fully succeeded. A thread the
 * backend refuses to delete is archived instead and reported, and the project is then kept;
 * `--restore <workDir>` replays cleanup from the journal. `--restart-for-readiness` restarts
 * the backend unit once (clients reconnect; the Rust unit and its terminals keep running).
 * Results go to `--out-dir` (default `~/bigbud-measure-results/`): a dated JSON and markdown.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { homedir, cpus, release, arch } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  connectRpc,
  handshake,
  loadWebSocket,
  waitForReady,
  type BackendEndpoint,
} from "./remoteBackendMeasure.client.ts";
import { type MeasurementResult, writeOutputs } from "./remoteBackendMeasure.report.ts";
import {
  databaseSize,
  latencyStats,
  readUnitPids,
  repeat,
  restartBackendUnit,
  sampleWindow,
} from "./remoteBackendMeasure.sample.ts";
import { runFakeProviderLevels } from "./remoteBackendMeasure.levels.ts";
import { cleanupWorkload, readJournal } from "./remoteBackendMeasure.workload.ts";

const { values } = parseArgs({
  options: {
    authority: { type: "string" },
    "backend-home": { type: "string", default: join(homedir(), "backend-data") },
    "graph-root": { type: "string", default: join(homedir(), "runtime", "backend") },
    "out-dir": { type: "string", default: join(homedir(), "bigbud-measure-results") },
    "work-dir": { type: "string" },
    levels: { type: "string", default: "1,4,8" },
    "history-turns": { type: "string", default: "10" },
    "measured-turns": { type: "string", default: "3" },
    "sample-ms": { type: "string", default: "500" },
    "idle-ms": { type: "string", default: "5000" },
    "latency-samples": { type: "string", default: "5" },
    "fake-provider": { type: "boolean", default: false },
    "restart-for-readiness": { type: "boolean", default: false },
    restore: { type: "string" },
  },
});

const authorityId = values.authority;
if (!authorityId || !/^[0-9a-f]{32}$/u.test(authorityId)) {
  throw new Error("--authority <32 hex characters> is required (see `bigbud backend status`).");
}
const int = (name: keyof typeof values, max: number) => {
  const value = Number(values[name]);
  if (!Number.isInteger(value) || value < 0 || value > max)
    throw new Error(`--${name} must be an integer from 0 to ${max}.`);
  return value;
};
const levels = String(values.levels)
  .split(",")
  .map((entry) => Number(entry));
if (levels.some((level) => !Number.isInteger(level) || level < 1 || level > 16)) {
  throw new Error("--levels takes session counts from 1 to 16, for example 1,4,8.");
}
const stateDir = join(String(values["backend-home"]), "userdata");
const endpoint: BackendEndpoint = {
  socketPath: join(stateDir, "remote-backend.sock"),
  token: readFileSync(
    join(homedir(), ".bigbud", "backend-services", authorityId, "client-token"),
    "utf8",
  ).trim(),
  authorityId,
};
const WebSocket = loadWebSocket(String(values["graph-root"]));
const sampleMs = int("sample-ms", 60_000);
const idleMs = int("idle-ms", 600_000);
const latencySamples = int("latency-samples", 50);

/** WS open, then config and (optionally) one thread's detail: what a reopening client does. */
async function reconnectOnce(threadId?: string): Promise<number> {
  const started = performance.now();
  const rpc = await connectRpc(WebSocket, endpoint);
  try {
    await rpc.call("server.getConfig", {});
    if (threadId)
      await rpc.call("orchestration.getSelectedThreadDetail", { threadId, messageLimit: 50 });
    return performance.now() - started;
  } finally {
    rpc.close();
  }
}

async function restore(workDir: string) {
  const rpc = await connectRpc(WebSocket, endpoint);
  try {
    const problems = await cleanupWorkload(rpc, workDir, readJournal(workDir));
    console.log(JSON.stringify({ restored: workDir, problems }, null, 2));
  } finally {
    rpc.close();
  }
}

async function main() {
  if (values.restore) return restore(values.restore);
  const startedAt = new Date().toISOString();
  await handshake(endpoint);
  let pids = readUnitPids(authorityId!);
  const memTotalKiB = Number(
    /MemTotal:\s+(\d+)/u.exec(readFileSync("/proc/meminfo", "utf8"))?.[1] ?? 0,
  );
  const databaseInitial = databaseSize(stateDir);
  const idle = await sampleWindow(pids, { intervalMs: sampleMs, idleMs });
  const handshakeStats = latencyStats(await repeat(latencySamples, () => handshake(endpoint)));
  const reconnectIdle = latencyStats(await repeat(latencySamples, () => reconnectOnce()));

  let readiness: MeasurementResult["readiness"] = null;
  if (values["restart-for-readiness"]) {
    const started = performance.now();
    const { stopMs } = await restartBackendUnit(authorityId!, pids.backend, 120_000);
    const processStarted = performance.now();
    await waitForReady(endpoint, processStarted, 120_000, 20);
    const startToReadyMs = performance.now() - processStarted;
    const restartToReadyMs = performance.now() - started;
    const firstReconnectMs = await reconnectOnce();
    pids = readUnitPids(authorityId!);
    const idleAfterRestart = await sampleWindow(pids, { intervalMs: sampleMs, idleMs });
    readiness = { stopMs, startToReadyMs, restartToReadyMs, firstReconnectMs, idleAfterRestart };
  }

  let levelResults: MeasurementResult["levels"] = [];
  let cleanupProblems: ReadonlyArray<string> = [];
  let databaseAfterCleanup: MeasurementResult["databaseAfterCleanup"] = null;
  if (values["fake-provider"]) {
    const workDir =
      values["work-dir"] ?? join(homedir(), `bigbud-measure-work-${startedAt.replaceAll(":", "")}`);
    mkdirSync(workDir, { recursive: true, mode: 0o700 });
    const outcome = await runFakeProviderLevels({
      WebSocket,
      endpoint,
      authorityId: authorityId!,
      pids,
      stateDir,
      workDir,
      scriptDir: dirname(fileURLToPath(import.meta.url)),
      levels,
      historyTurns: int("history-turns", 500),
      measuredTurns: int("measured-turns", 100),
      sampleMs,
      idleMs,
      latencySamples,
      reconnectOnce,
    });
    levelResults = outcome.levels;
    cleanupProblems = outcome.cleanupProblems;
    databaseAfterCleanup = databaseSize(stateDir);
  }

  const result: MeasurementResult = {
    tool: "remoteBackendMeasure",
    schemaVersion: 1,
    startedAt,
    finishedAt: new Date().toISOString(),
    host: { arch: arch(), kernel: release(), cpus: cpus().length, memTotalKiB },
    authorityId: authorityId!,
    pids,
    idle,
    handshake: handshakeStats,
    reconnectIdle,
    readiness,
    databaseInitial,
    databaseAfterCleanup,
    levels: levelResults,
    cleanupProblems,
  };
  const written = writeOutputs(String(values["out-dir"]), result);
  console.log(JSON.stringify(written));
  if (cleanupProblems.length > 0) process.exitCode = 3;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
