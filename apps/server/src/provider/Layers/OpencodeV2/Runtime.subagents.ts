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
import { providerSubagentEvent } from "../../providerSubagents.ts";
import { readV2ObservedChildren } from "./Runtime.subagents.read.ts";
import { v2SubagentAssignments } from "./Runtime.subagents.assignment.ts";
import { EventId } from "@bigbud/contracts/core/baseSchemas";
import { invalidateV2OwnedFamily } from "./Runtime.family.observe.ts";
import {
  V2_SUBAGENT_MAX_CHILDREN,
  demoteV2Subagent,
  hasV2SubagentCall,
  isV2SubagentLive,
  mapV2Subagent,
  type V2SubagentContent,
} from "./Runtime.subagents.map.ts";

interface V2SubagentObserverState {
  hinted: boolean;
  ordinal: number;
  readonly children: Map<string, V2SubagentUpdate & { readonly signature: string }>;
}

interface V2SubagentUpdate {
  readonly content: V2SubagentContent;
  /** Native `time.updated`, the provider revision that orders observations. */
  readonly updatedMs?: number;
  /** Native idle/outcome revisions can advance without changing `time.updated`. */
  readonly idleMs?: number;
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
  invalidateV2OwnedFamily(session);
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
  return providerSubagentEvent(
    {
      provider: "opencodeV2",
      threadId: session.threadId,
      sessionEpoch: session.epoch,
      eventId: EventId.makeUnsafe(
        `v2:${session.native.id}:subagent:${session.epoch}:${content.nativeId}:${ordinal}`,
      ),
      createdAt: new Date().toISOString(),
    },
    {
      ...content,
      nativeId: content.nativeId!,
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
  );
}

/** Idle markers order terminal evidence independently of ordinary session metadata updates. */
function isRegressedObservation(
  previous: V2SubagentUpdate | undefined,
  child: SessionInfo,
  content: V2SubagentContent,
) {
  if (!previous) return false;
  const updated = previous.updatedMs ?? -Infinity;
  if (child.time.updated < updated) return true;
  if (isV2SubagentLive(previous.content)) return false;
  const ended = previous.idleMs ?? updated;
  if (isV2SubagentLive(content)) return child.time.updated <= Math.max(updated, ended);
  if (previous.idleMs !== undefined && child.time.idle === undefined) return true;
  const nextEnded = child.time.idle ?? child.time.updated;
  return nextEnded < ended || (nextEnded === ended && content.status !== previous.content.status);
}

function changedUpdates(
  session: V2RuntimeSession,
  state: V2SubagentObserverState,
  children: ReadonlyArray<SessionInfo>,
  active: Parameters<typeof mapV2Subagent>[0]["active"],
  assistants: readonly SessionMessageInfo[],
) {
  const updates: V2SubagentUpdate[] = [];
  const observed = new Set<string>();
  if (
    new Set([...state.children.keys(), ...children.map((child) => child.id)]).size >
    V2_SUBAGENT_MAX_CHILDREN
  )
    throw new Error("V2 retained child observation capacity exceeded.");
  const assignments = v2SubagentAssignments(assistants, new Set(children.map((child) => child.id)));
  for (const child of children) {
    const previous = state.children.get(child.id);
    const assignment = assignments.get(child.id);
    // Only an exact launch call in this admitted turn proves first association.
    // Discovery during a newer turn is not evidence that the newer turn launched it.
    const turnId = previous?.content.turnId ?? (assignment ? session.row?.turnId : undefined);
    const content = {
      ...mapV2Subagent({
        threadId: session.threadId,
        epoch: session.epoch,
        child,
        active,
        ...(turnId ? { turnId } : {}),
      }),
      // A later root turn need not contain the earlier child's native launch call.
      // Preserve the exact correlated assignment instead of replacing it with a title.
      ...(previous?.content.parentToolUseId
        ? {
            description: previous.content.description,
            prompt: previous.content.prompt,
            background: previous.content.background,
            parentToolUseId: previous.content.parentToolUseId,
          }
        : {}),
      ...assignment,
    };
    if (isRegressedObservation(previous, child, content)) continue;
    observed.add(child.id);
    if (
      previous?.signature === JSON.stringify(content) &&
      previous.updatedMs === child.time.updated &&
      previous.idleMs === child.time.idle
    )
      continue;
    updates.push({
      content,
      updatedMs: child.time.updated,
      ...(child.time.idle !== undefined ? { idleMs: child.time.idle } : {}),
    });
  }
  // Listing absence is not deletion or settlement. Missing/regressed live children
  // retain their last known status, but no longer claim fresh activity.
  for (const [id, entry] of state.children) {
    if (observed.has(id)) continue;
    const content = demoteV2Subagent(entry.content);
    if (content)
      updates.push({
        content,
        ...(entry.updatedMs !== undefined ? { updatedMs: entry.updatedMs } : {}),
        ...(entry.idleMs !== undefined ? { idleMs: entry.idleMs } : {}),
      });
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
    const { children, active } = await readV2ObservedChildren(session, validate);
    validate();
    session.lease.hub.noteChildren(
      session.native.id,
      children.map((child) => child.id),
    );
    updates = changedUpdates(
      session,
      state,
      children.filter((child) => !session.family?.child(child.id)),
      active,
      assistants,
    );
  } catch {
    try {
      validate();
    } catch {
      return;
    }
    updates = Array.from(state.children.values()).flatMap((entry) => {
      const content = demoteV2Subagent(entry.content);
      return content
        ? [
            {
              content,
              ...(entry.updatedMs !== undefined ? { updatedMs: entry.updatedMs } : {}),
              ...(entry.idleMs !== undefined ? { idleMs: entry.idleMs } : {}),
            },
          ]
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
