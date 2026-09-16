import { CommandId, ProjectId } from "@bigbud/contracts/core/baseSchemas";
import type { OrchestrationCommand } from "@bigbud/contracts/orchestration/orchestration.commands.ts";
import type { MobileRecoveryFrame } from "@bigbud/contracts/server/mobile.recovery";
import { Deferred, Effect, Fiber, Stream } from "effect";

import {
  type BenchmarkResult,
  type RecoverySummary,
  type Scenario,
  type TimingSummary,
  PRESEEDED_BACKLOG_EVENTS,
  SMALL_PAYLOAD_BYTES,
} from "./mobileRecoveryMemoryBenchmark.config.ts";
import { createOrchestrationSystem } from "../src/orchestration/Layers/OrchestrationEngine.test.helpers.ts";
import type { OrchestrationEngineShape } from "../src/orchestration/Services/OrchestrationEngine.ts";
import { makeMobileRecoveryFrameStream } from "../src/ws/wsMobileRecovery.ts";

type OrchestrationSystem = Awaited<ReturnType<typeof createOrchestrationSystem>>;
type MutableRecoverySummary = {
  -readonly [Key in keyof RecoverySummary]: RecoverySummary[Key] extends ReadonlyArray<string>
    ? string[]
    : RecoverySummary[Key];
};

function projectCreate(projectId: ProjectId): OrchestrationCommand {
  return {
    type: "project.create",
    commandId: CommandId.makeUnsafe("mobile-memory-create"),
    projectId,
    title: "Mobile recovery memory fixture",
    workspaceRoot: "/tmp/mobile-recovery-memory-fixture",
    defaultModelSelection: { provider: "codex", model: "gpt-5.4" },
    createdAt: "2026-09-10T00:00:00.000Z",
  } as OrchestrationCommand;
}

function projectUpdate(
  projectId: ProjectId,
  phase: string,
  index: number,
  payloadBytes: number,
): OrchestrationCommand {
  return {
    type: "project.meta.update",
    commandId: CommandId.makeUnsafe(`mobile-memory-${phase}-${index}`),
    projectId,
    title: `fixture-${index}-${"x".repeat(payloadBytes)}`,
  } as OrchestrationCommand;
}

function summarizeTiming(samples: ReadonlyArray<number>): TimingSummary {
  const ordered = samples.toSorted((left, right) => left - right);
  return {
    count: samples.length,
    medianMs: ordered[Math.floor(ordered.length / 2)] ?? 0,
    p95Ms: ordered[Math.ceil(ordered.length * 0.95) - 1] ?? 0,
    maxMs: Math.max(...samples, 0),
  };
}

function makeRecoverySummary(): MutableRecoverySummary {
  return {
    batchCount: 0,
    replayEventCount: 0,
    liveEventCount: 0,
    caughtUpThroughSequence: null,
    resyncReasons: [],
  };
}

function recordRecoveryFrame(summary: MutableRecoverySummary, frame: MobileRecoveryFrame) {
  if (frame.type === "batch") {
    summary.batchCount += 1;
    if (summary.caughtUpThroughSequence === null) {
      summary.replayEventCount += frame.events.length;
    } else {
      summary.liveEventCount += frame.events.length;
    }
  } else if (frame.type === "caught-up") {
    summary.caughtUpThroughSequence = frame.throughSequence;
  } else {
    summary.resyncReasons.push(frame.reason);
  }
}

function assertRecoverySummary(scenario: Scenario, summary: MutableRecoverySummary) {
  const expectedReplayEventCount = PRESEEDED_BACKLOG_EVENTS + 1;
  const expectedReasons = scenario.name === "capture-drain" ? [] : ["overflow"];
  if (
    summary.batchCount === 0 ||
    summary.replayEventCount !== expectedReplayEventCount ||
    summary.resyncReasons.join(",") !== expectedReasons.join(",")
  ) {
    throw new Error(`Unexpected recovery frames for ${scenario.name}: ${JSON.stringify(summary)}`);
  }
  if (scenario.name === "capture-drain") {
    if (
      summary.caughtUpThroughSequence !== expectedReplayEventCount ||
      summary.liveEventCount !== scenario.count
    ) {
      throw new Error(
        `Recovery drain did not consume the expected boundary: ${JSON.stringify(summary)}`,
      );
    }
  } else if (
    summary.caughtUpThroughSequence !== expectedReplayEventCount ||
    summary.liveEventCount !== 0
  ) {
    throw new Error(
      `Overflow recovery emitted an unexpected completion: ${JSON.stringify(summary)}`,
    );
  }
}

function makeMemorySampler() {
  const before = process.memoryUsage();
  let sampledMaxRss = before.rss;
  let sampledMaxHeapUsed = before.heapUsed;
  let sampleCount = 0;
  const sample = () => {
    const current = process.memoryUsage();
    sampledMaxRss = Math.max(sampledMaxRss, current.rss);
    sampledMaxHeapUsed = Math.max(sampledMaxHeapUsed, current.heapUsed);
    sampleCount += 1;
  };
  const timer = setInterval(sample, 1);
  return {
    stop: () => clearInterval(timer),
    result: () => ({
      before,
      sampledMaxRss,
      sampledMaxHeapUsed,
      sampleCount,
      processHighWaterRssRaw: process.resourceUsage().maxRSS,
    }),
  };
}

async function dispatchMany(
  system: OrchestrationSystem,
  projectId: ProjectId,
  phase: string,
  count: number,
  payloadBytes: number,
) {
  const samples: number[] = [];
  for (let index = 1; index <= count; index += 1) {
    const started = performance.now();
    await system.run(system.engine.dispatch(projectUpdate(projectId, phase, index, payloadBytes)));
    samples.push(performance.now() - started);
  }
  return summarizeTiming(samples);
}

function drainReplay(engine: OrchestrationEngineShape) {
  return Effect.gen(function* () {
    let cursor = 0;
    let pages = 0;
    let events = 0;
    while (true) {
      const page = yield* engine.readReplay(cursor, 500);
      pages += 1;
      events += page.events.length;
      const nextCursor = page.events.at(-1)?.sequence ?? cursor;
      if (page.complete || nextCursor >= page.latestSequence) {
        return { pages, events, latestSequence: page.latestSequence };
      }
      if (nextCursor === cursor) return { pages, events, latestSequence: page.latestSequence };
      cursor = nextCursor;
    }
  });
}

async function runControl(system: OrchestrationSystem, projectId: ProjectId, scenario: Scenario) {
  const dispatch = await dispatchMany(
    system,
    projectId,
    "live",
    scenario.count,
    scenario.payloadBytes,
  );
  const replay = await system.run(drainReplay(system.engine));
  const expectedEvents = PRESEEDED_BACKLOG_EVENTS + scenario.count + 1;
  if (replay.events !== expectedEvents || replay.pages < 3) {
    throw new Error(`Control replay did not drain the seeded backlog: ${JSON.stringify(replay)}`);
  }
  return { dispatch, replay, recovery: null, semanticPass: true as const };
}

async function runRecovery(system: OrchestrationSystem, projectId: ProjectId, scenario: Scenario) {
  const epoch = system.engine.serverEpoch;
  if (epoch === undefined) throw new Error("The actual engine did not expose a recovery epoch.");

  return system.run(
    Effect.scoped(
      Effect.gen(function* () {
        const holdPoint = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const completed = yield* Deferred.make<void>();
        const summary = makeRecoverySummary();
        let publisher: Fiber.Fiber<ReturnType<typeof summarizeTiming>, never> | undefined;
        const recovery = yield* makeMobileRecoveryFrameStream({
          recoveryAttemptId: `memory-${scenario.name}`,
          baselineSequence: 0,
          clientServerEpoch: epoch,
          serverEpoch: epoch,
          orchestrationEngine: system.engine,
        });
        const consumer = yield* Effect.forkScoped(
          Stream.runForEach(recovery, (frame) =>
            Effect.gen(function* () {
              recordRecoveryFrame(summary, frame);
              if (frame.type === "batch" && summary.batchCount === 1) {
                if (scenario.name === "capture-drain") {
                  publisher = yield* Effect.forkScoped(
                    Effect.promise(() =>
                      dispatchMany(
                        system,
                        projectId,
                        "live",
                        scenario.count,
                        scenario.payloadBytes,
                      ),
                    ).pipe(Effect.orDie),
                  );
                  yield* Deferred.succeed(holdPoint, undefined);
                }
              }
              if (frame.type === "caught-up" && scenario.name !== "capture-drain") {
                publisher = yield* Effect.forkScoped(
                  Effect.promise(() =>
                    dispatchMany(system, projectId, "live", scenario.count, scenario.payloadBytes),
                  ).pipe(Effect.orDie),
                );
                yield* Deferred.succeed(holdPoint, undefined);
                yield* Deferred.await(release);
              }
              if (
                frame.type === "resync-required" ||
                (summary.caughtUpThroughSequence !== null &&
                  summary.liveEventCount >= scenario.count)
              ) {
                yield* Deferred.succeed(completed, undefined);
              }
            }),
          ),
        );
        yield* Deferred.await(holdPoint);
        const publisherFiber = publisher;
        if (publisherFiber === undefined) {
          return yield* Effect.die("The recovery publisher was not started.");
        }
        const dispatch = yield* Fiber.join(publisherFiber);
        if (scenario.name === "capture-drain") {
          yield* Deferred.await(completed);
          yield* Fiber.interrupt(consumer);
        } else {
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(consumer);
        }
        assertRecoverySummary(scenario, summary);
        return { dispatch, recovery: summary, replay: null, semanticPass: true as const };
      }),
    ),
  );
}

export async function runWorker(scenario: Scenario): Promise<BenchmarkResult> {
  const system = await createOrchestrationSystem();
  const projectId = ProjectId.makeUnsafe(`mobile-memory-${scenario.name}`);
  let sampler: ReturnType<typeof makeMemorySampler> | undefined;
  try {
    await system.run(system.engine.dispatch(projectCreate(projectId)));
    Bun.gc(true);
    sampler = makeMemorySampler();
    const preseedDispatch = await dispatchMany(
      system,
      projectId,
      "preseed",
      PRESEEDED_BACKLOG_EVENTS,
      SMALL_PAYLOAD_BYTES,
    );
    const result =
      scenario.mode === "control"
        ? await runControl(system, projectId, scenario)
        : await runRecovery(system, projectId, scenario);
    sampler.stop();
    const after = process.memoryUsage();
    Bun.gc(true);
    const afterGc = process.memoryUsage();
    return {
      ...scenario,
      ...result,
      preseedDispatch,
      memory: { ...sampler.result(), after, afterGc },
      runtime: {
        bun: Bun.version,
        platform: process.platform,
        arch: process.arch,
      },
      scope:
        "isolated process; actual event store/projectors; actual mobile recovery replay/capture for recovery cases; synthetic in-memory SQLite; no userdata",
    };
  } finally {
    sampler?.stop();
    await system.dispose();
  }
}
