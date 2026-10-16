/**
 * Read-only OpenCode V2 subagent observer.
 *
 * Runs at the end of the parent's reconcile when its projected output contains a native
 * `subagent` tool call, a child hint arrived, or a known child is still live. It only reads
 * (`session.list({ parentID })` and `session.active()`), never mutates or owns a child, and
 * never fails the parent: a failed read demotes known children to "last seen".
 *
 * Its events carry no top-level `turnId`, so they are never turn liveness evidence for
 * dead-thread recovery, and they never touch the admission journal or session status.
 *
 * @module OpencodeV2Runtime.subagents
 */
import type { SessionInfo, SessionMessageInfo } from "@opencode/client";
import type { ProviderRuntimeEvent } from "@bigbud/contracts";
import type { OpencodeV2Runtime } from "./Runtime.ts";
import type { V2RuntimeSession } from "./Runtime.types.ts";
import { v2Request } from "./Client.ts";
import { EventId } from "@bigbud/contracts/core/baseSchemas";
import {
  V2_SUBAGENT_MAX_CHILDREN,
  demoteV2Subagent,
  hasV2SubagentCall,
  isV2SubagentLive,
  mapV2Subagent,
  v2ObservedChildren,
  type V2SubagentContent,
} from "./Runtime.subagents.map.ts";

const OBSERVER_TIMEOUT_MS = 5_000;

interface V2SubagentObserverState {
  hinted: boolean;
  ordinal: number;
  readonly children: Map<string, V2SubagentUpdate & { readonly signature: string }>;
}

interface V2SubagentUpdate {
  readonly content: V2SubagentContent;
  /** Native `time.updated`, the provider revision that orders observations. */
  readonly updatedMs?: number;
}

const observers = new WeakMap<V2RuntimeSession, V2SubagentObserverState>();

function observerState(session: V2RuntimeSession): V2SubagentObserverState {
  let state = observers.get(session);
  if (!state) {
    state = { hinted: false, ordinal: 0, children: new Map() };
    observers.set(session, state);
  }
  return state;
}

/** EventHub child hint: request a bounded observer refresh through the coalesced repair queue. */
export function noteV2ChildHint(runtime: OpencodeV2Runtime, session: V2RuntimeSession) {
  if (session.stopped) return;
  observerState(session).hinted = true;
  runtime.scheduleRepair(session, false);
}

function taskEvent(
  session: V2RuntimeSession,
  state: V2SubagentObserverState,
  { content, updatedMs }: V2SubagentUpdate,
): ProviderRuntimeEvent {
  const ordinal = ++state.ordinal;
  // No top-level turnId: observer output is never turn liveness evidence.
  return {
    provider: "opencodeV2",
    threadId: session.threadId,
    sessionEpoch: session.epoch,
    eventId: EventId.makeUnsafe(
      `v2:${session.native.id}:subagent:${session.epoch}:${content.nativeId}:${ordinal}`,
    ),
    createdAt: new Date().toISOString(),
    type: "task.updated",
    payload: {
      ...content,
      source: "observed",
      freshness: {
        sessionEpoch: String(session.epoch),
        sourcePriority: 3,
        ...(updatedMs !== undefined && Number.isFinite(updatedMs)
          ? { providerRevision: updatedMs }
          : {}),
        observedOrdinal: ordinal,
      },
    },
  };
}

async function readChildren(session: V2RuntimeSession) {
  const client = session.lease.process.client;
  const listing = await v2Request(
    "session.list",
    (signal) =>
      client.session.list(
        { parentID: session.native.id, limit: V2_SUBAGENT_MAX_CHILDREN },
        { signal },
      ),
    { timeoutMs: OBSERVER_TIMEOUT_MS },
  );
  const children = v2ObservedChildren(listing.data, session.native.id);
  const active =
    children.length === 0
      ? {}
      : await v2Request("session.active", (signal) => client.session.active({ signal }), {
          timeoutMs: OBSERVER_TIMEOUT_MS,
        });
  return { children, active };
}

function changedUpdates(
  session: V2RuntimeSession,
  state: V2SubagentObserverState,
  children: ReadonlyArray<SessionInfo>,
  active: Parameters<typeof mapV2Subagent>[0]["active"],
) {
  const updates: V2SubagentUpdate[] = [];
  for (const child of children) {
    if (!state.children.has(child.id) && state.children.size >= V2_SUBAGENT_MAX_CHILDREN) break;
    const content = mapV2Subagent({
      threadId: session.threadId,
      epoch: session.epoch,
      child,
      active,
      ...(session.row ? { turnId: session.row.turnId } : {}),
    });
    if (state.children.get(child.id)?.signature === JSON.stringify(content)) continue;
    updates.push({ content, updatedMs: child.time.updated });
  }
  return updates;
}

/** Observe children after a successful reconcile. Never throws and never fails the parent. */
export async function observeV2Subagents(
  runtime: OpencodeV2Runtime,
  session: V2RuntimeSession,
  assistants: ReadonlyArray<SessionMessageInfo>,
  validate: () => void,
): Promise<void> {
  const state = observerState(session);
  const hinted = state.hinted;
  state.hinted = false;
  const live = Array.from(state.children.values()).some((entry) => isV2SubagentLive(entry.content));
  if (!hinted && !live && !hasV2SubagentCall(assistants)) return;
  let updates: V2SubagentUpdate[];
  try {
    const { children, active } = await readChildren(session);
    validate();
    session.lease.hub.noteChildren(
      session.native.id,
      children.map((child) => child.id),
    );
    updates = changedUpdates(session, state, children, active);
  } catch {
    try {
      validate();
    } catch {
      return;
    }
    updates = Array.from(state.children.values()).flatMap((entry) => {
      const content = demoteV2Subagent(entry.content);
      return content
        ? [{ content, ...(entry.updatedMs !== undefined ? { updatedMs: entry.updatedMs } : {}) }]
        : [];
    });
  }
  for (const update of updates) {
    try {
      await runtime.emit(session, taskEvent(session, state, update), validate);
    } catch {
      return;
    }
    state.children.set(update.content.nativeId!, {
      ...update,
      signature: JSON.stringify(update.content),
    });
  }
}
