/**
 * Cleanup for the provider conformance harness (WP-5D), modelled on the measurement tool:
 * stop every journaled session, delete the threads, verify they are gone (archiving any the
 * backend refused to delete), delete the project, and remove the work directory only when
 * every step succeeded. `--restore <workDir>` replays this from the journal.
 */
import { randomUUID } from "node:crypto";

import type { RpcClient } from "../remoteBackendMeasure.client.ts";
import { stopSession } from "./rows.context.ts";
import { delay, dispatch, errorText } from "./session.ts";
import { CONFORMANCE_PREFIX, type RestoreJournal, type Workspace } from "./workspace.ts";

export interface CleanupTiming {
  readonly deadlineMs: number;
  readonly pollMs: number;
  readonly settleMs: number;
}

export const DEFAULT_CLEANUP_TIMING: CleanupTiming = {
  deadlineMs: 30_000,
  pollMs: 250,
  settleMs: 3_000,
};

const isOwned = (id: string) => id.startsWith(`${CONFORMANCE_PREFIX}-`);

async function remainingThreads(rpc: RpcClient, projectId: string): Promise<string[]> {
  const result = (await rpc.call("orchestration.getProjectThreadSummaries", {
    projectId,
    limit: 100,
  })) as { threads?: ReadonlyArray<{ id: string }> };
  return (result.threads ?? []).map((thread) => thread.id);
}

export async function cleanupRun(
  rpc: RpcClient,
  journal: RestoreJournal,
  workspace: Workspace | null,
  timing: CleanupTiming = DEFAULT_CLEANUP_TIMING,
): Promise<ReadonlyArray<string>> {
  const problems: string[] = [];
  const attempt = async (label: string, run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      problems.push(`${label}: ${errorText(error)}`);
    }
  };
  // Never touch anything the harness did not name.
  const threadIds = journal.threadIds.filter(isOwned);
  for (const threadId of threadIds) await stopSession(rpc, threadId);
  for (const threadId of threadIds)
    await attempt(`delete ${threadId}`, () =>
      dispatch(rpc, { type: "thread.delete", commandId: randomUUID(), threadId }),
    );
  const projectId = journal.projectId && isOwned(journal.projectId) ? journal.projectId : null;
  if (projectId) {
    await attempt("verify thread deletion", async () => {
      const started = performance.now();
      let left = await remainingThreads(rpc, projectId);
      while (left.length > 0 && performance.now() - started < timing.deadlineMs) {
        await delay(timing.pollMs);
        left = await remainingThreads(rpc, projectId);
      }
      // Deletion can fail late and bring a thread back, so check again after settling.
      if (left.length === 0) {
        await delay(timing.settleMs);
        left = await remainingThreads(rpc, projectId);
      }
      if (left.length === 0) return;
      for (const threadId of left.filter(isOwned))
        await attempt(`archive undeleted ${threadId}`, () =>
          dispatch(rpc, { type: "thread.archive", commandId: randomUUID(), threadId }),
        );
      throw new Error(`${left.length} thread(s) were not deleted and were archived instead`);
    });
    if (problems.length === 0)
      await attempt("delete project", () =>
        dispatch(rpc, { type: "project.delete", commandId: randomUUID(), projectId }),
      );
    else problems.push(`project ${projectId} kept because its threads were not deleted`);
  }
  if (problems.length === 0 && workspace) await attempt("remove work directory", workspace.remove);
  return problems;
}
