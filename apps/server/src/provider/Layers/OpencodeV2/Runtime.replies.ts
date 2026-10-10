import type { ThreadId, TurnId } from "@bigbud/contracts";
import { v2Request } from "./Client.ts";
import { assertV2SharedSessionOwner } from "./Runtime.ownership.ts";

/** Interrupt cancellation must enter before the session queue held by the executing command. */
export async function interruptV2Execution(
  runtime: OpencodeV2Runtime,
  threadId: ThreadId,
  turnId?: TurnId,
) {
  const session = runtime.get(threadId);
  if (turnId && turnId !== session.row?.turnId)
    throw new Error("V2 interrupt turn fence rejected.");
  await session.coding?.cancelActive();
  return runtime.withSession(threadId, async () => {
    if (runtime.get(threadId) !== session || (turnId && turnId !== session.row?.turnId))
      throw new Error("V2 interrupt owner fence rejected.");
    await assertV2SharedSessionOwner(session, false);
    await v2Request("session.interrupt", (signal) =>
      session.lease.process.client.session.interrupt(
        { sessionID: session.native.id, resume: false },
        { signal },
      ),
    );
    await runtime.reconcile(session);
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
) {
  const generation = owner.lease.generation;
  const epoch = owner.epoch;
  const nativeId = owner.native.id;
  const validate = () => {
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
    await assertV2SharedSessionOwner(owner);
    validate();
    return validate;
  };
}
