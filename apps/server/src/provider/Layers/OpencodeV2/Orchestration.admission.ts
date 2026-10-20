import { Effect } from "effect";
import { setTimeout as delay } from "node:timers/promises";
import type { OpencodeV2Runtime } from "./Runtime.ts";
import type { V2RuntimeSession } from "./Runtime.types.ts";
import type { V2ThreadInvocation } from "./Orchestration.callback.ts";
import { correlatedProjection, readV2Messages } from "./Runtime.projection.ts";
import { v2ReplyGuard } from "./Runtime.replies.ts";
import { v2PermissionEffect } from "./Runtime.policy.match.ts";
import { V2_THREAD_ACTIONS } from "./Orchestration.protocol.ts";
import { runWithAbortableDeadline } from "../../RequestDeadline.ts";
import { v2NativeToolName } from "./Runtime.registration.ts";

/** All narrow native actions must remain usable under the original final-rule order; never append grants. */
export function assertV2ThreadPolicy(
  session: Pick<V2RuntimeSession, "toolPolicy"> & Partial<Pick<V2RuntimeSession, "native">>,
) {
  for (const action of V2_THREAD_ACTIONS) {
    if (
      !session.toolPolicy ||
      v2PermissionEffect(session.toolPolicy, `bigbud_thread_v1_${action}`, "*") === "deny" ||
      v2PermissionEffect(session.toolPolicy, v2NativeToolName(session.native, action), "*") ===
        "deny"
    )
      throw new Error(
        "V2 required thread-tools denied by retained native policy; history preserved read-only without grant changes.",
      );
  }
}

/** Correlation waits outside native/admission queues; timestamps and callback credentials cannot prove an input interval. */
export async function guardV2ThreadInvocation(
  runtime: OpencodeV2Runtime,
  session: V2RuntimeSession,
  request: V2ThreadInvocation,
  assertEnrollment: () => void,
  signal: AbortSignal,
) {
  return runWithAbortableDeadline({
    operation: "V2 canonical admission correlation",
    timeoutMs: 2000,
    signal,
    run: (bounded) =>
      correlateV2ThreadInvocation(runtime, session, request, assertEnrollment, bounded),
  });
}

async function correlateV2ThreadInvocation(
  runtime: OpencodeV2Runtime,
  session: V2RuntimeSession,
  request: V2ThreadInvocation,
  assertEnrollment: () => void,
  signal: AbortSignal,
) {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(2000)]);
  const deadline = Date.now() + 2000;
  const validateOwner = await v2ReplyGuard(runtime.options, runtime.sessions, session, bounded)();
  assertEnrollment();
  validateOwner();
  assertV2ThreadPolicy(session);
  await Effect.runPromise(runtime.options.journal.assertOwnerAvailable(session.threadId));
  assertEnrollment();
  validateOwner();
  bounded.throwIfAborted();
  while (Date.now() < deadline) {
    const row = session.row;
    if (row && row.namespace !== "foreground")
      throw new Error("V2 hidden work cannot acquire canonical tools.");
    if (row?.state === "terminal") throw new Error("V2 canonical tool admission terminal.");
    if (row?.state === "accepted" && !session.publicationUnconfirmed && !session.stopped) {
      const persisted = await Effect.runPromise(
        runtime.options.journal.find({
          namespace: row.namespace,
          ownerThreadId: row.ownerThreadId,
          requestMessageId: row.requestMessageId,
        }),
      );
      assertEnrollment();
      validateOwner();
      bounded.throwIfAborted();
      if (
        !persisted ||
        persisted.state !== "accepted" ||
        persisted.fingerprint !== row.fingerprint ||
        persisted.nativeAdmissionId !== row.nativeAdmissionId ||
        persisted.turnId !== row.turnId
      )
        throw new Error("V2 canonical journal owner changed.");
      const messages = await readV2Messages(session, bounded);
      const projection = correlatedProjection(session, messages);
      assertEnrollment();
      validateOwner();
      bounded.throwIfAborted();
      const assistant = projection?.assistants.find((message) => message.id === request.messageID);
      const part = assistant?.content.find(
        (item) => item.type === "tool" && item.id === request.callID,
      );
      if (assistant && part?.type === "tool") {
        if (
          request.sessionID !== session.native.id ||
          assistant.agent !== request.agent ||
          part.name !== v2NativeToolName(session.native, request.action) ||
          part.state.status !== "running" ||
          JSON.stringify(part.state.input) !== JSON.stringify(request.input)
        )
          throw new Error("V2 canonical native tool call correlation rejected.");
        const dirty = session.dirtyGeneration;
        const hub = session.lease.hub.generation(session.native.id);
        return () => {
          signal.throwIfAborted();
          assertEnrollment();
          validateOwner();
          if (
            session.row !== row ||
            row.state !== "accepted" ||
            session.publicationUnconfirmed ||
            session.dirtyGeneration !== dirty ||
            session.lease.hub.generation(session.native.id) !== hub
          )
            throw new Error("V2 canonical invocation projection/owner changed.");
        };
      }
      const admittedPresent = messages.some(
        (message) =>
          message.id === row.nativeAdmissionId &&
          message.type === "user" &&
          message.metadata?.bigbud_fingerprint === row.fingerprint,
      );
      if ((!projection && admittedPresent) || projection?.idle)
        throw new Error("V2 canonical input interval is unconfirmed.");
    }
    await delay(20, undefined, { signal: bounded });
  }
  throw new Error("V2 canonical invocation admission correlation timed out.");
}
