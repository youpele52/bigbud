/**
 * The 1/4/8-session phase of the remote backend measurement (WP-6A). Sessions accumulate:
 * level 4 reuses level 1's thread and adds three, so each level has `historyTurns` of seeded
 * history per thread before its measured window. Cleanup always runs.
 */
import { join } from "node:path";

import {
  connectRpc,
  type BackendEndpoint,
  type WebSocketLike,
} from "./remoteBackendMeasure.client.ts";
import type { LevelResult } from "./remoteBackendMeasure.report.ts";
import {
  databaseSize,
  latencyStats,
  repeat,
  sampleWindow,
  type UnitPids,
} from "./remoteBackendMeasure.sample.ts";
import {
  applyCodexSettings,
  cleanupWorkload,
  createProject,
  createThread,
  installFakeCodex,
  readCodexSettings,
  runTurnsConcurrently,
  writeJournal,
  type RestoreJournal,
} from "./remoteBackendMeasure.workload.ts";

export interface LevelsInput {
  readonly WebSocket: new (url: string, options: object) => WebSocketLike;
  readonly endpoint: BackendEndpoint;
  readonly authorityId: string;
  readonly pids: UnitPids;
  readonly stateDir: string;
  readonly workDir: string;
  readonly scriptDir: string;
  readonly levels: ReadonlyArray<number>;
  readonly historyTurns: number;
  readonly measuredTurns: number;
  readonly sampleMs: number;
  readonly idleMs: number;
  readonly latencySamples: number;
  readonly reconnectOnce: (threadId?: string) => Promise<number>;
}

/** A realistic assistant turn: ~2 KB of streamed prose, reasoning and 40 lines of tool output. */
export const DEFAULT_TURN_SHAPE = { deltas: 40, deltaChars: 48, outputLines: 40, deltaMs: 10 };

export async function runFakeProviderLevels(input: LevelsInput): Promise<{
  readonly levels: ReadonlyArray<LevelResult>;
  readonly cleanupProblems: ReadonlyArray<string>;
}> {
  const rpc = await connectRpc(input.WebSocket, input.endpoint);
  let journal: RestoreJournal = {
    authorityId: input.authorityId,
    createdAt: new Date().toISOString(),
    codex: await readCodexSettings(rpc),
    projectId: null,
    threadIds: [],
  };
  writeJournal(input.workDir, journal);
  const results: LevelResult[] = [];
  let turnIndex = 0;
  let failure: unknown;
  try {
    const wrapper = installFakeCodex(input.workDir, input.scriptDir, DEFAULT_TURN_SHAPE);
    await applyCodexSettings(rpc, {
      enabled: true,
      binaryPath: wrapper,
      homePath: join(input.workDir, "codex-home"),
    });
    const projectId = await createProject(rpc, input.workDir);
    journal = { ...journal, projectId };
    writeJournal(input.workDir, journal);
    const threadIds: string[] = [];
    for (const sessions of input.levels) {
      const added: string[] = [];
      while (threadIds.length < sessions) {
        const threadId = await createThread(rpc, projectId, threadIds.length + 1);
        threadIds.push(threadId);
        added.push(threadId);
        journal = { ...journal, threadIds: [...threadIds] };
        writeJournal(input.workDir, journal);
      }
      await runTurnsConcurrently(rpc, projectId, added, input.historyTurns, turnIndex);
      turnIndex += input.historyTurns;
      const active = threadIds.slice(0, sessions);
      const databaseBefore = databaseSize(input.stateDir);
      let durations: ReadonlyArray<number> = [];
      const window = await sampleWindow(input.pids, { intervalMs: input.sampleMs }, async () => {
        durations = await runTurnsConcurrently(
          rpc,
          projectId,
          active,
          input.measuredTurns,
          turnIndex,
        );
      });
      turnIndex += input.measuredTurns;
      const idleAfter = await sampleWindow(input.pids, {
        intervalMs: input.sampleMs,
        idleMs: input.idleMs,
      });
      const databaseAfter = databaseSize(input.stateDir);
      const reconnect = latencyStats(
        await repeat(input.latencySamples, () => input.reconnectOnce(active[0])),
      );
      results.push({
        sessions,
        historyTurnsPerSession: input.historyTurns,
        measuredTurnsPerSession: input.measuredTurns,
        turnLatency: latencyStats(durations),
        window,
        idleAfter,
        databaseBefore,
        databaseAfter,
        reconnect,
      });
      console.error(`measured ${sessions} session(s)`);
    }
  } catch (error) {
    failure = error;
  } finally {
    rpc.close();
  }
  // Cleanup runs on success and failure; a failed run reports after cleanup.
  const cleanupRpc = await connectRpc(input.WebSocket, input.endpoint);
  let cleanupProblems: ReadonlyArray<string>;
  try {
    cleanupProblems = await cleanupWorkload(cleanupRpc, input.workDir, journal);
  } finally {
    cleanupRpc.close();
  }
  if (failure !== undefined) {
    console.error(`cleanup after failure: ${JSON.stringify(cleanupProblems)}`);
    throw failure;
  }
  return { levels: results, cleanupProblems };
}
