/**
 * Fake-provider workload for the remote backend measurement (WP-6A).
 *
 * Everything it creates is named `bigbud-measure-*`: one disposable project whose workspace is
 * `<workDir>/project`, its threads, and one Codex app-server process per thread (the fake in
 * remoteBackendMeasure.fakeCodex.ts). It temporarily points the backend's Codex provider at
 * the fake and restores the previous Codex settings afterwards (also on failure, and from the
 * journal with `--restore` if the tool itself was killed).
 */
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { RpcClient } from "./remoteBackendMeasure.client.ts";

export const MEASURE_PREFIX = "bigbud-measure";
const TURN_DEADLINE_MS = 120_000;
const POLL_MS = 250;
const CLEANUP_DEADLINE_MS = 30_000;
const SETTLE_MS = 3_000;
const FAILED_TURN_STATES = new Set(["failed", "interrupted", "error", "aborted", "cancelled"]);

export interface TurnShape {
  readonly deltas: number;
  readonly deltaChars: number;
  readonly outputLines: number;
  readonly deltaMs: number;
}

export interface CodexSettingsSnapshot {
  readonly enabled: boolean;
  readonly binaryPath: string;
  readonly homePath: string;
}

export interface RestoreJournal {
  readonly authorityId: string;
  readonly createdAt: string;
  readonly codex: CodexSettingsSnapshot;
  readonly projectId: string | null;
  readonly threadIds: ReadonlyArray<string>;
}

const nowIso = () => new Date().toISOString();
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const dispatch = (rpc: RpcClient, command: Record<string, unknown>) =>
  rpc.call("orchestration.dispatchCommand", command);

export function journalPath(workDir: string): string {
  return join(workDir, "restore-journal.json");
}

export function writeJournal(workDir: string, journal: RestoreJournal): void {
  writeFileSync(journalPath(workDir), `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
}

export function readJournal(workDir: string): RestoreJournal {
  return JSON.parse(readFileSync(journalPath(workDir), "utf8")) as RestoreJournal;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Write `<workDir>/bin/codex`, a wrapper that runs the fake with the graph's own Node. */
export function installFakeCodex(workDir: string, scriptDir: string, shape: TurnShape): string {
  const bin = join(workDir, "bin");
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  const wrapper = join(bin, "codex");
  writeFileSync(
    wrapper,
    [
      "#!/bin/sh",
      `export BB_FAKE_CODEX_DELTAS=${shape.deltas} BB_FAKE_CODEX_DELTA_CHARS=${shape.deltaChars}`,
      `export BB_FAKE_CODEX_OUTPUT_LINES=${shape.outputLines} BB_FAKE_CODEX_DELTA_MS=${shape.deltaMs}`,
      `exec ${shellQuote(process.execPath)} ${shellQuote(join(scriptDir, "remoteBackendMeasure.fakeCodex.ts"))} "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(wrapper, 0o700);
  return wrapper;
}

export async function readCodexSettings(rpc: RpcClient): Promise<CodexSettingsSnapshot> {
  const settings = (await rpc.call("server.getSettings", {})) as {
    providers: { codex: CodexSettingsSnapshot };
  };
  const { enabled, binaryPath, homePath } = settings.providers.codex;
  return { enabled, binaryPath, homePath };
}

export async function applyCodexSettings(rpc: RpcClient, codex: CodexSettingsSnapshot) {
  await rpc.call("server.updateSettings", { patch: { providers: { codex } } });
}

export async function createProject(rpc: RpcClient, workDir: string): Promise<string> {
  const projectId = `${MEASURE_PREFIX}-project-${randomUUID()}`;
  const workspaceRoot = join(workDir, "project");
  mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
  writeFileSync(join(workspaceRoot, "README.md"), "Disposable bigbud measurement project.\n");
  await dispatch(rpc, {
    type: "project.create",
    commandId: randomUUID(),
    projectId,
    title: `${MEASURE_PREFIX} (disposable)`,
    workspaceRoot,
    createdAt: nowIso(),
  });
  return projectId;
}

export async function createThread(rpc: RpcClient, projectId: string, index: number) {
  const threadId = `${MEASURE_PREFIX}-thread-${index}-${randomUUID()}`;
  await dispatch(rpc, {
    type: "thread.create",
    commandId: randomUUID(),
    projectId,
    threadId,
    title: `${MEASURE_PREFIX} session ${index}`,
    modelSelection: { provider: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: nowIso(),
  });
  return threadId;
}

interface ThreadSummaryRow {
  readonly id: string;
  readonly latestTurn?: { readonly turnId: string; readonly state: string } | null;
}

let summariesCache:
  | { readonly projectId: string; readonly at: number; readonly rows: Promise<ThreadSummaryRow[]> }
  | undefined;

async function projectThreads(rpc: RpcClient, projectId: string): Promise<ThreadSummaryRow[]> {
  const result = (await rpc.call("orchestration.getProjectThreadSummaries", {
    projectId,
    limit: 100,
  })) as { threads: ThreadSummaryRow[] };
  return result.threads;
}

/**
 * One shared thread-summary poll per interval for all waiting turns, so the measurement's own
 * RPC load stays near what one open client costs instead of growing with the session count.
 */
function sharedSummaries(rpc: RpcClient, projectId: string): Promise<ThreadSummaryRow[]> {
  const now = performance.now();
  if (summariesCache?.projectId === projectId && now - summariesCache.at < POLL_MS) {
    return summariesCache.rows;
  }
  const rows = projectThreads(rpc, projectId);
  summariesCache = { projectId, at: now, rows };
  return rows;
}

const latestTurnOf = async (rpc: RpcClient, projectId: string, threadId: string) =>
  (await sharedSummaries(rpc, projectId)).find((row) => row.id === threadId)?.latestTurn ?? null;

/** Send one turn and wait until the thread's latest turn is that new turn, completed. */
export async function runTurn(
  rpc: RpcClient,
  projectId: string,
  threadId: string,
  turnIndex: number,
) {
  const before = (await latestTurnOf(rpc, projectId, threadId))?.turnId ?? null;
  const started = performance.now();
  await dispatch(rpc, {
    type: "thread.turn.start",
    commandId: randomUUID(),
    threadId,
    message: {
      messageId: randomUUID(),
      role: "user",
      text: `Measurement turn ${turnIndex}: list the source files and summarise them.`,
      attachments: [],
    },
    modelSelection: { provider: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: nowIso(),
  });
  while (performance.now() - started < TURN_DEADLINE_MS) {
    await delay(POLL_MS);
    const latest = await latestTurnOf(rpc, projectId, threadId);
    if (latest && latest.turnId !== before) {
      if (latest.state === "completed") return performance.now() - started;
      if (FAILED_TURN_STATES.has(latest.state))
        throw new Error(`turn ${turnIndex} on ${threadId} ended ${latest.state}`);
    }
  }
  throw new Error(`turn ${turnIndex} on ${threadId} did not complete in ${TURN_DEADLINE_MS} ms`);
}

/** Run `turns` sequential turns on every thread, with the threads running concurrently. */
export async function runTurnsConcurrently(
  rpc: RpcClient,
  projectId: string,
  threadIds: ReadonlyArray<string>,
  turns: number,
  firstIndex: number,
): Promise<ReadonlyArray<number>> {
  const durations = await Promise.all(
    threadIds.map(async (threadId) => {
      const perThread: number[] = [];
      for (let turn = 0; turn < turns; turn += 1) {
        perThread.push(await runTurn(rpc, projectId, threadId, firstIndex + turn));
      }
      return perThread;
    }),
  );
  return durations.flat();
}

async function waitUntil(check: () => Promise<boolean>): Promise<boolean> {
  const started = performance.now();
  while (performance.now() - started < CLEANUP_DEADLINE_MS) {
    if (await check()) return true;
    await delay(POLL_MS);
  }
  return false;
}

/**
 * Stop the sessions, delete the threads and then the project, verifying each step. A thread
 * the backend refuses to delete is archived instead and reported, so nothing is left visible
 * and the report says exactly what remains. The work directory is removed only when every
 * step succeeded. Best effort per step.
 */
export async function cleanupWorkload(
  rpc: RpcClient,
  workDir: string,
  journal: RestoreJournal,
): Promise<ReadonlyArray<string>> {
  const problems: string[] = [];
  const attempt = async (label: string, run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      problems.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const remaining = async () =>
    journal.projectId === null ? [] : await projectThreads(rpc, journal.projectId);
  for (const threadId of journal.threadIds) {
    await attempt(`stop ${threadId}`, () =>
      dispatch(rpc, {
        type: "thread.session.stop",
        commandId: randomUUID(),
        threadId,
        createdAt: nowIso(),
      }),
    );
  }
  for (const threadId of journal.threadIds) {
    await attempt(`delete ${threadId}`, () =>
      dispatch(rpc, { type: "thread.delete", commandId: randomUUID(), threadId }),
    );
  }
  await attempt("verify thread deletion", async () => {
    // Threads being deleted drop out of the summaries and come back if deletion fails, so
    // the list must stay empty across two checks after the request has had time to settle.
    await delay(SETTLE_MS);
    const empty = async () => (await remaining()).length === 0;
    if ((await waitUntil(empty)) && (await delay(SETTLE_MS), await empty())) return;
    const left = await remaining();
    for (const thread of left) {
      await attempt(`archive undeleted ${thread.id}`, () =>
        dispatch(rpc, { type: "thread.archive", commandId: randomUUID(), threadId: thread.id }),
      );
    }
    throw new Error(`${left.length} thread(s) were not deleted and were archived instead`);
  });
  if (journal.projectId !== null && problems.length === 0) {
    const projectId = journal.projectId;
    await attempt("delete project", () =>
      dispatch(rpc, { type: "project.delete", commandId: randomUUID(), projectId }),
    );
  } else if (journal.projectId !== null) {
    problems.push(`project ${journal.projectId} kept because its threads were not deleted`);
  }
  await attempt("restore codex settings", () => applyCodexSettings(rpc, journal.codex));
  if (problems.length === 0) rmSync(workDir, { recursive: true, force: true });
  return problems;
}
