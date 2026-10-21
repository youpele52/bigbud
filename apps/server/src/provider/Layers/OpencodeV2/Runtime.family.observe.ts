import { EventId, RuntimeTaskId, TurnId } from "@bigbud/contracts/core/baseSchemas";
import type { OpencodeV2Runtime } from "./Runtime.ts";
import type { V2RuntimeSession } from "./Runtime.types.ts";
import { readV2ChildDrain } from "./Runtime.family.drain.ts";
import { mapV2Subagent } from "./Runtime.subagents.map.ts";
import { providerSubagentEvent } from "../../providerSubagents.ts";
import { v2Request } from "./Client.ts";
import { pendingV2FamilyInteractions } from "./Runtime.family.interactions.ts";
import { v2OwnedChildSteps } from "./Runtime.family.progress.ts";
import { v2NativeFailureMessage } from "./Runtime.failure.ts";
import { randomUUID } from "node:crypto";
import type { ProviderRuntimeEvent } from "@bigbud/contracts";
import { hasV2RetainedFamily, v2RuntimeStatus } from "./Runtime.status.ts";

const observed = new WeakMap<V2RuntimeSession, Map<string, string>>();
const ordinals = new WeakMap<V2RuntimeSession, number>();
type TaskEvent = Extract<ProviderRuntimeEvent, { type: "task.updated" }>;
const lastSeen = new WeakMap<V2RuntimeSession, Map<string, TaskEvent>>();

/** One coalesced metadata/history refresh; child SSE frames never become root output. */
export function invalidateV2OwnedFamily(owner: V2RuntimeSession) {
  observed.get(owner)?.clear();
}

/** Idle/background repair is independent of root admission or root terminal delivery. */
export async function observeV2OwnedFamily(
  runtime: OpencodeV2Runtime,
  owner: V2RuntimeSession,
  validate: () => void,
) {
  try {
    await reconcileV2OwnedFamily(runtime, owner, validate);
    if (Boolean(owner.session.retainedFamily) !== hasV2RetainedFamily(owner))
      await v2RuntimeStatus(
        runtime,
        owner,
        owner.session.status === "running"
          ? owner.runtimeState?.state === "waiting"
            ? "waiting"
            : "running"
          : owner.session.status === "error"
            ? "error"
            : "ready",
        owner.session.lastError,
        validate,
      );
  } catch (error) {
    validate();
    invalidateV2OwnedFamily(owner);
    for (const [id, event] of lastSeen.get(owner) ?? []) {
      if (!event.payload.activityFresh) continue;
      const stale: TaskEvent = {
        ...event,
        eventId: EventId.makeUnsafe(`v2:owned-stale:${id}:${randomUUID()}`),
        createdAt: new Date().toISOString(),
        payload: {
          ...event.payload,
          activityFresh: false,
          freshness: {
            ...event.payload.freshness,
            observedOrdinal: Math.max(Date.now(), (ordinals.get(owner) ?? 0) + 1),
          },
        },
      };
      ordinals.set(owner, stale.payload.freshness.observedOrdinal);
      await runtime.emit(owner, stale, validate);
      lastSeen.get(owner)!.set(id, stale);
    }
    throw error;
  }
}

async function reconcileV2OwnedFamily(
  runtime: OpencodeV2Runtime,
  owner: V2RuntimeSession,
  validate: () => void,
) {
  await owner.familyControl?.refreshNative?.();
  validate();
  if (!owner.family?.children.length) return;
  let signatures = observed.get(owner);
  if (!signatures) {
    signatures = new Map();
    observed.set(owner, signatures);
  }
  const active = await v2Request("owned family active", (signal) =>
    owner.lease.process.client.session.active({ signal }),
  );
  validate();
  for (const child of owner.family.children) {
    const { native, terminal, inbox, permissions, forms } = await readV2ChildDrain(
      owner,
      child,
      active,
      validate,
    );
    validate();
    const signature = JSON.stringify([
      native.time,
      native.outcome,
      active[child.id],
      owner.family.child(child.id),
      inbox,
      permissions,
      forms,
    ]);
    if (signatures.get(child.id) === signature) continue;
    const page = await v2Request("owned child messages", (signal) =>
      owner.lease.process.client.message.list(
        { sessionID: child.id, order: "desc", limit: 100 },
        { signal },
      ),
    );
    if (page.data.length > 100) throw new Error("V2 owned child message bound exceeded.");
    validate();
    const last = page.data.find((message) => message.type === "assistant");
    const recentSteps = v2OwnedChildSteps(page.data);
    const text =
      last?.type === "assistant"
        ? last.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("")
            .slice(0, 8192)
        : undefined;
    const parent = owner.family.child(child.parentId);
    const mapped = mapV2Subagent({
      threadId: owner.threadId,
      epoch: owner.epoch,
      child: native,
      active,
    });
    const ordinal = Math.max(Date.now(), (ordinals.get(owner) ?? 0) + 1);
    ordinals.set(owner, ordinal);
    const event = providerSubagentEvent(
      {
        provider: "opencodeV2",
        threadId: owner.threadId,
        sessionEpoch: owner.epoch,
        eventId: EventId.makeUnsafe(`v2:owned:${child.taskId}:${owner.epoch}:${randomUUID()}`),
        createdAt: new Date().toISOString(),
      },
      {
        ...mapped,
        taskId: RuntimeTaskId.makeUnsafe(child.taskId),
        nativeId: child.id,
        status: terminal ? mapped.status : active[child.id] ? "inProgress" : "pending",
        activityFresh: Boolean(active[child.id]),
        source: "observed",
        recentSteps,
        ...(recentSteps.at(-1) ? { lastToolName: recentSteps.at(-1)!.toolName } : {}),
        ...(terminal && mapped.status === "failed"
          ? {
              terminalReason: v2NativeFailureMessage(last?.type === "assistant" ? last : undefined),
            }
          : {}),
        description: child.description,
        prompt: child.prompt,
        subagentType: child.agent,
        background: child.background,
        parentToolUseId: child.callId,
        depth: child.depth,
        ...(parent
          ? { parentTaskId: RuntimeTaskId.makeUnsafe(parent.taskId), parentAgentId: parent.id }
          : {}),
        ...(child.turnId ? { turnId: TurnId.makeUnsafe(child.turnId) } : {}),
        ...(text ? (terminal ? { resultSummary: text } : { progressSummary: text }) : {}),
        freshness: {
          sessionEpoch: String(owner.epoch),
          sourcePriority: 3,
          observedOrdinal: ordinal,
          providerRevision: Math.max(native.time.updated, native.time.idle ?? 0),
        },
      },
    );
    await runtime.emit(owner, event, validate);
    if (!lastSeen.has(owner)) lastSeen.set(owner, new Map());
    lastSeen.get(owner)!.set(child.id, event);
    signatures.set(child.id, signature);
  }
  validate();
  owner.lease.hub.noteOwnedChildren(
    owner.native.id,
    owner.family.children.filter((child) => child.state !== "terminal").map((child) => child.id),
  );
  await pendingV2FamilyInteractions(runtime, owner, validate);
}
