/**
 * Shared per-provider context and the thread wrapper for session rows (WP-5D). Every row runs
 * on its own fresh `bigbud-conformance-thread-<row>-*` thread, recorded in the journal before
 * it is created, and its session is stopped as soon as the row ends so a small host never
 * holds more than one conformance session at a time.
 */
import { randomBytes, randomUUID } from "node:crypto";

import type { RpcClient } from "../remoteBackendMeasure.client.ts";
import type { ConformanceBackend } from "./client.ts";
import { result, type Evidence, type Provider, type RowId, type RowResult } from "./rows.ts";
import {
  createThread,
  dispatch,
  errorText,
  nowIso,
  type ThreadRef,
  type Timing,
} from "./session.ts";
import type { Journal, Workspace } from "./workspace.ts";

/** Per-run nonces. They go into prompts and workspace files only, never into the report. */
export interface Tokens {
  readonly text: string;
  readonly attachment: string;
  readonly tool: string;
  readonly approval: string;
  readonly replay: string;
  readonly duplicate: string;
}

export interface ProviderContext {
  readonly backend: ConformanceBackend;
  readonly rpc: RpcClient;
  readonly provider: Provider;
  readonly model: string;
  readonly projectId: string;
  readonly journal: Journal;
  readonly workspace: Workspace;
  readonly timing: Timing;
  readonly tokens: Tokens;
}

export const FILES = {
  tool: "bigbud-conformance-tool.txt",
  approval: "bigbud-conformance-approval.txt",
  attachment: "bigbud-conformance-attachment.txt",
} as const;

const nonce = () => `BBCONF-${randomBytes(4).toString("hex").toUpperCase()}`;

export const makeTokens = (): Tokens => ({
  text: nonce(),
  attachment: nonce(),
  tool: nonce(),
  approval: nonce(),
  replay: nonce(),
  duplicate: nonce(),
});

/** Write the fixture files the tool and approval rows read. */
export async function writeFixtures(workspace: Workspace, tokens: Tokens): Promise<void> {
  await workspace.writeFile("README.md", "Disposable bigbud conformance project.\n");
  await workspace.writeFile(FILES.tool, `${tokens.tool}\n`);
  await workspace.writeFile(FILES.approval, `${tokens.approval}\n`);
}

export interface Modes {
  readonly runtimeMode: "full-access" | "approval-required";
  readonly interactionMode: "default" | "plan";
}
export const FULL_ACCESS: Modes = { runtimeMode: "full-access", interactionMode: "default" };

export interface RowOutcome {
  readonly status: RowResult["status"];
  readonly reason: string;
  readonly evidence?: Evidence;
}

export async function stopSession(rpc: RpcClient, threadId: string): Promise<void> {
  try {
    await dispatch(rpc, {
      type: "thread.session.stop",
      commandId: randomUUID(),
      threadId,
      createdAt: nowIso(),
    });
  } catch {
    // Best effort: cleanup stops and deletes every journaled thread again.
  }
}

/** Create the row's thread, run it, always stop its session, and turn throws into `fail`. */
export async function withThread(
  context: ProviderContext,
  row: RowId,
  modes: Modes,
  run: (thread: ThreadRef) => Promise<RowOutcome>,
): Promise<RowResult> {
  const started = performance.now();
  let thread: ThreadRef | undefined;
  try {
    thread = await createThread(context.rpc, context.journal, {
      projectId: context.projectId,
      provider: context.provider,
      model: context.model,
      row,
      ...modes,
    });
    const outcome = await run(thread);
    return result(
      row,
      context.provider,
      outcome.status,
      outcome.reason,
      outcome.evidence,
      performance.now() - started,
    );
  } catch (error) {
    return result(
      row,
      context.provider,
      "fail",
      `error: ${errorText(error)}`,
      {},
      performance.now() - started,
    );
  } finally {
    if (thread) await stopSession(context.rpc, thread.threadId);
  }
}
