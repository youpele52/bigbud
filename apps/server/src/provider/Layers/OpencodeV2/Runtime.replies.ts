import type { ThreadId, TurnId } from "@bigbud/contracts";
import { v2Request } from "./Client.ts";
import { assertV2SharedSessionOwner } from "./Runtime.ownership.ts";
import { currentV2RequestContext } from "./Client.guard.ts";
import { nextV2SettlementSequence } from "./Execution.owners.ts";
import { stopV2OwnedDescendants } from "./Runtime.family.stop.ts";
import {
  replyV2FamilyInteraction,
  closeV2FamilyInteractions,
} from "./Runtime.family.interactions.ts";
import { cancelV2FamilyRootInputs } from "./Runtime.family.inputs.ts";

/** Interrupt cancellation must enter before the session queue held by the executing command. */
export async function interruptV2Execution(
  runtime: OpencodeV2Runtime,
  threadId: ThreadId,
  turnId?: TurnId,
) {
  const session = runtime.get(threadId);
  if (turnId && turnId !== session.row?.turnId)
    throw new Error("V2 interrupt turn fence rejected.");
  const familyFence = session.family?.fence();
  const codingCancellation = session.coding?.cancelActive();
  return runtime.withCleanupSession(threadId, async () => {
    if (runtime.get(threadId) !== session || (turnId && turnId !== session.row?.turnId))
      throw new Error("V2 interrupt owner fence rejected.");
    await assertV2SharedSessionOwner(session, false);
    const results = await Promise.allSettled([
      familyFence,
      codingCancellation,
      session.familyControl?.fence(),
      closeV2FamilyInteractions(runtime, session),
      cancelV2FamilyRootInputs(session),
      v2Request("session.interrupt", (signal) =>
        session.lease.process.client.session.interrupt(
          { sessionID: session.native.id, resume: false },
          { signal },
        ),
      ).then(() => {
        session.interruptAcknowledgedSequence = nextV2SettlementSequence();
      }),
      stopV2OwnedDescendants(session),
    ]);
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    await cancelV2FamilyRootInputs(session);
    try {
      session.consentPermit?.assertCurrent();
    } catch {
      return;
    }
    // Repair uses a new execution permit, never the cleanup-only request context.
    runtime.scheduleRepair(session);
  });
}
import type { V2IsolatedRuntimeOptions, V2RuntimeSession } from "./Runtime.types.ts";
import type { OpencodeV2Runtime } from "./Runtime.ts";
import { replyV2Permission, replyV2Form } from "./Runtime.interactions.ts";

/** Discovery already holds the owner queue; use the normal mutation fences without recursively acquiring that queue. */
export function installV2UnsafePermissionRejector(
  runtime: OpencodeV2Runtime,
  owner: V2RuntimeSession,
) {
  owner.rejectUnsafePermission = async (id) => {
    runtime.mutations.assertSafe();
    return replyV2Permission(
      owner,
      id,
      "decline",
      runtime.mutations,
      v2ReplyGuard(runtime.options, runtime.sessions, owner),
    );
  };
}

export async function respondV2Permission(
  runtime: OpencodeV2Runtime,
  threadId: ThreadId,
  id: string,
  decision: Parameters<typeof replyV2Permission>[2],
) {
  const owner = runtime.get(threadId);
  if (id.startsWith("bbv2-child:"))
    return runtime.withSession(threadId, () =>
      replyV2FamilyInteraction(runtime, owner, id, decision, "permission"),
    );
  if (id.startsWith("bbv2-thread:"))
    return runtime.withSession(threadId, () => {
      if (!runtime.options.threadBridge) throw new Error("V2 canonical thread bridge unavailable.");
      return runtime.options.threadBridge.reply(runtime, owner, id, decision);
    });
  if (id.startsWith("bbv2-code:"))
    return runtime.withSession(threadId, () => {
      if (!runtime.options.codingBridge) throw new Error("V2 coding bridge unavailable.");
      return runtime.options.codingBridge.reply(runtime, owner, id, decision);
    });
  const guard = v2ReplyGuard(runtime.options, runtime.sessions, owner);
  return runtime.withSession(threadId, async () => {
    await runtime.emit(
      owner,
      await replyV2Permission(owner, id, decision, runtime.mutations, guard),
    );
    owner.pendingInteractions?.delete(`request.opened:${id}`);
  });
}

export async function respondV2Form(
  runtime: OpencodeV2Runtime,
  threadId: ThreadId,
  id: string,
  answers: Parameters<typeof replyV2Form>[2],
) {
  const owner = runtime.get(threadId);
  if (id.startsWith("bbv2-child:"))
    return runtime.withSession(threadId, () =>
      replyV2FamilyInteraction(runtime, owner, id, answers, "form"),
    );
  const guard = v2ReplyGuard(runtime.options, runtime.sessions, owner);
  return runtime.withSession(threadId, async () => {
    await runtime.emit(owner, await replyV2Form(owner, id, answers, runtime.mutations, guard));
    owner.pendingInteractions?.delete(`user-input.requested:${id}`);
  });
}

/** Inside the namespace reservation. Even denial may resume native execution; disable requires stop. */
export function v2ReplyGuard(
  options: V2IsolatedRuntimeOptions,
  sessions: Map<ThreadId, V2RuntimeSession>,
  owner: V2RuntimeSession,
  cancellation?: AbortSignal,
) {
  const generation = owner.lease.generation;
  const epoch = owner.epoch;
  const nativeId = owner.native.id;
  const permit = currentV2RequestContext()?.permit;
  const validate = () => {
    permit?.assertCurrent();
    owner.consentPermit?.assertCurrent();
    if (
      sessions.get(owner.threadId) !== owner ||
      owner.stopped ||
      owner.lease.generation !== generation ||
      owner.epoch !== epoch ||
      owner.native.id !== nativeId ||
      !owner.lease.process.isRunning()
    )
      throw new Error("V2 queued reply owner/generation lost.");
    if (owner.executionBlocked) throw new Error(owner.executionBlocked);
  };
  return async () => {
    await options.authorizeExecution?.();
    await assertV2SharedSessionOwner(owner, true, cancellation);
    validate();
    return validate;
  };
}
