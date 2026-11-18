/**
 * Thread lifecycle and event observation for the provider conformance harness (WP-5D).
 *
 * Observation uses only `orchestration.replayEvents` from the thread's creation sequence, so
 * the harness sees exactly what a reconnecting client replays: messages, activities
 * (tool/approval/question) and `thread.turn-settled`.
 */
import { randomUUID } from "node:crypto";

import type { RpcClient } from "../remoteBackendMeasure.client.ts";
import { CONFORMANCE_PREFIX, type Journal } from "./workspace.ts";

export interface ReplayedEvent {
  readonly sequence: number;
  readonly eventId: string;
  readonly type: string;
  readonly aggregateId: string;
  readonly commandId: string | null;
  readonly payload: Record<string, unknown>;
}

export interface ReplayPage {
  readonly availability: "available" | "gap";
  readonly events: ReadonlyArray<ReplayedEvent>;
}

export interface Timing {
  readonly turnDeadlineMs: number;
  readonly pollMs: number;
  readonly cancelAfterMs: number;
  readonly disconnectMs: number;
}

export interface ThreadRef {
  readonly threadId: string;
  /** Replay cursor: the sequence `thread.create` returned. */
  readonly cursor: number;
}

export interface Activity {
  readonly kind: string;
  readonly requestId: string | null;
  readonly payload: Record<string, unknown>;
}

export interface ThreadView {
  readonly events: ReadonlyArray<ReplayedEvent>;
  readonly activities: ReadonlyArray<Activity>;
  /** Message id to role and reduced text (same reduction as the server projector). */
  readonly messages: ReadonlyMap<string, { readonly role: string; readonly text: string }>;
  readonly settled: ReadonlyArray<{ readonly turnId: string; readonly outcome: string }>;
  readonly turnStartFailed: boolean;
}

export const nowIso = () => new Date().toISOString();
export const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

export const dispatch = async (rpc: RpcClient, command: Record<string, unknown>) =>
  record(await rpc.call("orchestration.dispatchCommand", command));

export async function createProject(rpc: RpcClient, journal: Journal, workspaceRoot: string) {
  const projectId = `${CONFORMANCE_PREFIX}-project-${randomUUID()}`;
  journal.setProject(projectId);
  await dispatch(rpc, {
    type: "project.create",
    commandId: randomUUID(),
    projectId,
    title: `${CONFORMANCE_PREFIX} (disposable)`,
    workspaceRoot,
    createdAt: nowIso(),
  });
  return projectId;
}

export async function createThread(
  rpc: RpcClient,
  journal: Journal,
  input: {
    readonly projectId: string;
    readonly provider: string;
    readonly model: string;
    readonly row: string;
    readonly runtimeMode: string;
    readonly interactionMode: string;
  },
): Promise<ThreadRef> {
  const threadId = `${CONFORMANCE_PREFIX}-thread-${input.row}-${randomUUID()}`;
  journal.addThread(threadId);
  const result = await dispatch(rpc, {
    type: "thread.create",
    commandId: randomUUID(),
    projectId: input.projectId,
    threadId,
    title: `${CONFORMANCE_PREFIX} ${input.row} ${input.provider}`,
    modelSelection: { provider: input.provider, model: input.model },
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
    branch: null,
    worktreePath: null,
    createdAt: nowIso(),
  });
  return { threadId, cursor: Number(result.sequence ?? 0) };
}

export function turnStartCommand(input: {
  readonly threadId: string;
  readonly provider: string;
  readonly model: string;
  readonly text: string;
  readonly attachments?: ReadonlyArray<unknown>;
  readonly runtimeMode: string;
  readonly interactionMode: string;
}) {
  return {
    type: "thread.turn.start",
    commandId: randomUUID(),
    threadId: input.threadId,
    message: {
      messageId: randomUUID(),
      role: "user",
      text: input.text,
      attachments: input.attachments ?? [],
    },
    modelSelection: { provider: input.provider, model: input.model },
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
    createdAt: nowIso(),
  };
}

/** Every event after `fromExclusive`, following pages until the replay is complete. */
export async function replayAll(rpc: RpcClient, fromExclusive: number): Promise<ReplayPage> {
  const events: ReplayedEvent[] = [];
  let cursor = fromExclusive;
  let availability: ReplayPage["availability"] = "available";
  for (let page = 0; page < 10_000; page += 1) {
    const result = record(
      await rpc.call("orchestration.replayEvents", { fromSequenceExclusive: cursor }),
    );
    if (result.availability === "gap") availability = "gap";
    const batch = Array.isArray(result.events) ? (result.events as ReplayedEvent[]) : [];
    events.push(...batch);
    const last = batch.at(-1)?.sequence;
    if (result.complete === true || last === undefined || last <= cursor) break;
    cursor = last;
  }
  return { availability, events };
}

export function reduceThread(events: ReadonlyArray<ReplayedEvent>, threadId: string): ThreadView {
  const own = events.filter((event) => event.aggregateId === threadId);
  const activities: Activity[] = [];
  const messages = new Map<string, { role: string; text: string }>();
  const settled: Array<{ turnId: string; outcome: string }> = [];
  let turnStartFailed = false;
  for (const event of own) {
    const payload = record(event.payload);
    if (event.type === "thread.activity-appended") {
      const activity = record(payload.activity);
      const inner = record(activity.payload);
      activities.push({
        kind: String(activity.kind ?? ""),
        requestId: typeof inner.requestId === "string" ? inner.requestId : null,
        payload: inner,
      });
    } else if (event.type === "thread.message-sent") {
      const id = String(payload.messageId);
      const text = String(payload.text ?? "");
      const previous = messages.get(id)?.text ?? "";
      const next =
        payload.replace === true
          ? text
          : payload.streaming === true
            ? previous + text
            : text.length > 0
              ? text
              : previous;
      messages.set(id, { role: String(payload.role), text: next });
    } else if (event.type === "thread.turn-settled") {
      settled.push({ turnId: String(payload.turnId), outcome: String(payload.outcome) });
    } else if (event.type === "thread.turn-start-failed") {
      turnStartFailed = true;
    }
  }
  return { events: own, activities, messages, settled, turnStartFailed };
}

export const assistantText = (view: ThreadView) =>
  [...view.messages.values()]
    .filter((message) => message.role === "assistant")
    .map((message) => message.text)
    .join("\n");

export const containsToken = (text: string, token: string) =>
  text.toLowerCase().includes(token.toLowerCase());

/** Poll the replay until `done(view)` holds; resolves with the last view and whether it held. */
export async function waitForView(
  rpc: RpcClient,
  thread: ThreadRef,
  timing: Timing,
  done: (view: ThreadView) => boolean,
): Promise<{ readonly view: ThreadView; readonly met: boolean }> {
  const started = performance.now();
  let view = reduceThread([], thread.threadId);
  while (performance.now() - started < timing.turnDeadlineMs) {
    view = reduceThread((await replayAll(rpc, thread.cursor)).events, thread.threadId);
    if (done(view)) return { view, met: true };
    await delay(timing.pollMs);
  }
  return { view, met: false };
}

export const isSettled = (view: ThreadView) => view.settled.length > 0 || view.turnStartFailed;

export const pendingRequest = (view: ThreadView, requested: string, resolved: string) => {
  const closed = new Set(
    view.activities.filter((entry) => entry.kind === resolved).map((entry) => entry.requestId),
  );
  return view.activities.find(
    (entry) => entry.kind === requested && entry.requestId && !closed.has(entry.requestId),
  );
};

export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
