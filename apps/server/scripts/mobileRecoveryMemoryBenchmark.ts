import {
  type BenchmarkResult,
  CAPTURE_BYTES,
  CAPTURE_CAPACITY,
  COUNT_OVERFLOW_EVENTS,
  DEFAULT_OUTPUT,
  DISPATCH_SAMPLES,
  LARGE_PAYLOAD_BYTES,
  MEMORY_RATIO_GATE,
  PRESEEDED_BACKLOG_EVENTS,
  RESULT_PREFIX,
  WORKER_TIMEOUT_MS,
  scenarios,
} from "./mobileRecoveryMemoryBenchmark.config.ts";
import { runWorker } from "./mobileRecoveryMemoryBenchmark.worker.ts";

function hasExpectedSemanticResult(result: BenchmarkResult) {
  const expectedEvents = PRESEEDED_BACKLOG_EVENTS + result.count + 1;
  if (result.mode === "control") {
    return (
      result.semanticPass &&
      result.recovery === null &&
      result.replay?.events === expectedEvents &&
      result.replay.pages >= 3
    );
  }
  const recovery = result.recovery;
  if (recovery === null || recovery.replayEventCount !== PRESEEDED_BACKLOG_EVENTS + 1) {
    return false;
  }
  if (result.name === "capture-drain") {
    return (
      recovery.caughtUpThroughSequence === PRESEEDED_BACKLOG_EVENTS + 1 &&
      recovery.liveEventCount === result.count &&
      recovery.resyncReasons.length === 0
    );
  }
  return (
    recovery.caughtUpThroughSequence === PRESEEDED_BACKLOG_EVENTS + 1 &&
    recovery.liveEventCount === 0 &&
    recovery.resyncReasons.length === 1 &&
    recovery.resyncReasons[0] === "overflow"
  );
}

function isFinitePositive(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

function positiveRatio(value: number, control: number): number | null {
  if (!isFinitePositive(value) || !isFinitePositive(control)) return null;
  return value / control;
}

async function readWorkerOutput(child: ReturnType<typeof Bun.spawn>, scenarioName: string) {
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, WORKER_TIMEOUT_MS);
  try {
    const stdout = child.stdout;
    if (typeof stdout === "number" || stdout === undefined) {
      throw new Error(`${scenarioName} worker did not expose piped stdout.`);
    }
    const output = await new Response(stdout).text();
    const exitCode = await child.exited;
    if (timedOut) throw new Error(`${scenarioName} worker exceeded ${WORKER_TIMEOUT_MS} ms.`);
    if (exitCode !== 0) {
      throw new Error(`${scenarioName} worker exited with ${exitCode}: ${output}`);
    }
    return output;
  } finally {
    clearTimeout(timer);
  }
}

async function runParent() {
  const results: BenchmarkResult[] = [];
  for (const scenario of scenarios) {
    const child = Bun.spawn([process.execPath, import.meta.filename, "--worker", scenario.name], {
      cwd: process.cwd(),
      env: process.env,
      stdout: "pipe",
      stderr: "inherit",
    });
    const output = await readWorkerOutput(child, scenario.name);
    const line = output.split("\n").find((candidate) => candidate.startsWith(RESULT_PREFIX));
    if (line === undefined) throw new Error(`No result from ${scenario.name} worker.`);
    results.push(JSON.parse(line.slice(RESULT_PREFIX.length)) as BenchmarkResult);
  }

  const byName = new Map(results.map((result) => [result.name, result]));
  const comparisons = [
    ["capture-drain", "control-drain"],
    ["count-overflow", "control-count"],
    ["byte-overflow", "control-byte"],
  ] as const;
  const comparisonResults = comparisons.map(([scenarioName, controlName]) => {
    const scenario = byName.get(scenarioName);
    const control = byName.get(controlName);
    const processHighWaterRssRatio =
      scenario === undefined || control === undefined
        ? null
        : positiveRatio(
            scenario.memory.processHighWaterRssRaw,
            control.memory.processHighWaterRssRaw,
          );
    const sampledMaxHeapUsedRatio =
      scenario === undefined || control === undefined
        ? null
        : positiveRatio(scenario.memory.sampledMaxHeapUsed, control.memory.sampledMaxHeapUsed);
    return {
      scenario: scenarioName,
      control: controlName,
      processHighWaterRssRatio,
      sampledMaxHeapUsedRatio,
    };
  });
  const semanticAssertionsPass = results.every(hasExpectedSemanticResult);
  const ratiosFinitePositive = comparisonResults.every(
    (comparison) =>
      isFinitePositive(comparison.processHighWaterRssRatio) &&
      isFinitePositive(comparison.sampledMaxHeapUsedRatio),
  );

  const report = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    workload: {
      preseededCanonicalEvents: PRESEEDED_BACKLOG_EVENTS,
      replayPageLimit: 500,
      captureCapacity: CAPTURE_CAPACITY,
      captureBytes: CAPTURE_BYTES,
      captureDrainEvents: DISPATCH_SAMPLES,
      countOverflowLiveEvents: COUNT_OVERFLOW_EVENTS,
      byteOverflowLiveEvents: DISPATCH_SAMPLES,
      byteOverflowPayloadBytes: LARGE_PAYLOAD_BYTES,
    },
    memoryRatioGate: {
      threshold: MEMORY_RATIO_GATE,
      captureLimits: { capacity: CAPTURE_CAPACITY, bytes: CAPTURE_BYTES },
      meaning:
        "provisional fixture comparison only; each recovery case is compared with a fresh no-capture process using the same preseed, dispatch count, and payload size",
      comparisons: comparisonResults,
      semanticAssertionsPass,
      ratiosFinitePositive,
      observedPass:
        semanticAssertionsPass &&
        ratiosFinitePositive &&
        comparisonResults.every(
          (comparison) =>
            comparison.processHighWaterRssRatio !== null &&
            comparison.processHighWaterRssRatio <= MEMORY_RATIO_GATE &&
            comparison.sampledMaxHeapUsedRatio !== null &&
            comparison.sampledMaxHeapUsedRatio <= MEMORY_RATIO_GATE,
        ),
      doesNotProve:
        "an allocator-level or high-frequency peak, a mobile budget, or production behavior",
    },
    results,
  };
  const outputPath = process.env.BIGBUD_MOBILE_MEMORY_OUTPUT ?? DEFAULT_OUTPUT;
  await Bun.write(outputPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[2] === "--worker") {
  const scenario = scenarios.find((candidate) => candidate.name === process.argv[3]);
  if (scenario === undefined) throw new Error(`Unknown scenario: ${process.argv[3] ?? ""}`);
  console.log(`${RESULT_PREFIX}${JSON.stringify(await runWorker(scenario))}`);
} else {
  await runParent();
}
