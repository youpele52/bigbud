import { Effect } from "effect";
import { providerAttachmentIssue } from "@bigbud/shared/providerAttachments";
import type { ProviderSendTurnInput } from "@bigbud/contracts/orchestration/provider.ts";
import type { OpencodeV2Runtime } from "./Runtime.ts";
import { dispatchV2Turn, runtimeAdmissionIdentity } from "./Runtime.admission.ts";
import { v2Request } from "./Client.ts";
import { v2ExecutionGuard } from "./Runtime.authorization.ts";
import { switchV2TurnModel } from "./Runtime.model.ts";
import { v2RuntimeStatus } from "./Runtime.status.ts";
import { v2ResumeCursor } from "./Runtime.sessions.ts";
import { runtimeEventBase } from "./Runtime.projection.ts";
import { prepareV2TurnAttachments } from "./Runtime.attachments.ts";

/** Serialize admission against the exact owner; native dispatch rechecks authorization after awaited reads. */
export function sendV2Turn(runtime: OpencodeV2Runtime, input: ProviderSendTurnInput) {
  const attachmentIssue = providerAttachmentIssue("opencodeV2", input.attachments);
  if (attachmentIssue) throw new Error(attachmentIssue);
  const session = runtime.get(input.threadId);
  const guard = v2ExecutionGuard(runtime, session, input.learningJob?.ownerThreadId);
  return runtime.withSession(input.threadId, async () => {
    runtime.mutations.assertSafe();
    await guard();
    runtime.mutations.assertSafe();
    const identity = runtimeAdmissionIdentity(input);
    const existing = await Effect.runPromise(runtime.options.journal.find(identity));
    if (
      session.row &&
      !session.terminalDelivered &&
      session.row.requestMessageId !== identity.requestMessageId
    )
      throw new Error("V2 previous admission is unresolved; new work may duplicate execution.");
    const active = await v2Request("session.active", (signal) =>
      session.lease.process.client.session.active({ signal }),
    );
    if (!existing && active[session.native.id])
      throw new Error("V2 native execution is already active; no queued duplicate work.");
    const prepared = await prepareV2TurnAttachments(
      runtime.options,
      session,
      input,
      Boolean(existing),
    );
    if (!existing) await switchV2TurnModel(runtime, session, input);
    if (!existing) {
      session.messages.clear();
      session.terminalDelivered = false;
    }
    try {
      session.row = await dispatchV2Turn(
        runtime.options,
        session,
        input,
        runtime.mutations,
        guard,
        prepared,
      );
    } catch (error) {
      session.row = await Effect.runPromise(runtime.options.journal.find(identity));
      if (session.row)
        await v2RuntimeStatus(
          runtime,
          session,
          "error",
          "Admission unconfirmed. No automatic resend; new work may duplicate execution.",
        );
      throw error;
    }
    if (session.row.state === "terminal") {
      await runtime.reconcile(session);
      return {
        threadId: input.threadId,
        turnId: session.row.turnId,
        resumeCursor: v2ResumeCursor(session),
      };
    }
    session.session = {
      ...session.session,
      status: "running",
      activeTurnId: session.row.turnId,
      updatedAt: new Date().toISOString(),
    };
    await runtime.emit(session, {
      ...runtimeEventBase(session, `started:${session.row.turnId}`),
      type: "turn.started",
      payload: { model: session.model.id },
    });
    await runtime.reconcile(session);
    return {
      threadId: input.threadId,
      turnId: session.row.turnId,
      resumeCursor: v2ResumeCursor(session),
    };
  });
}
