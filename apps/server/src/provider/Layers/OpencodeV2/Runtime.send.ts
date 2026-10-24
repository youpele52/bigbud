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
import { captureV2AdmissionOwner, withV2AdmissionOperation } from "./Runtime.admission.owner.ts";
import {
  currentV2CallerSignal,
  assertV2CallerCurrent,
  bindV2CallerSession,
} from "./Runtime.caller.ts";
import {
  awaitV2RuntimeReady,
  V2PreAdmissionRetry,
  settleV2RuntimeReservation,
} from "./Runtime.activation.ts";
import { logV2SettlementHold } from "./Runtime.settlement.ts";
import { supersedeV2ReservedAdmission } from "./Runtime.admission.supersede.ts";

/** Serialize admission against the exact owner; native dispatch rechecks authorization after awaited reads. */
export async function sendV2Turn(runtime: OpencodeV2Runtime, input: ProviderSendTurnInput) {
  assertV2CallerCurrent();
  const attachmentIssue = providerAttachmentIssue("opencodeV2", input.attachments);
  if (attachmentIssue) throw new Error(attachmentIssue);
  const session = runtime.get(input.threadId);
  bindV2CallerSession(session.native.id);
  const liveGuard = v2ExecutionGuard(runtime, session, input.learningJob?.ownerThreadId);
  const guard = async () => {
    assertV2CallerCurrent();
    const validate = await liveGuard();
    assertV2CallerCurrent();
    return () => {
      assertV2CallerCurrent();
      validate();
    };
  };
  const initial = await Effect.runPromise(
    runtime.options.journal.find(runtimeAdmissionIdentity(input)),
  );
  // Installer waiting never owns the session queue needed by terminal/control settlement.
  for (let retry = 0; retry < 3; retry++) {
    const ready =
      !initial || initial.state === "reserved"
        ? await awaitV2RuntimeReady(
            runtime.options,
            session.lease.process.client,
            session.native.location.directory,
            currentV2CallerSignal(),
            !session.localTools,
            {
              threadId: session.threadId,
              nativeSessionId: session.native.id,
              storageIdentity: session.storageIdentity,
              directory: session.native.location.directory,
              registrationFamily:
                session.native.metadata?.bigbud_registration === "scoped" ? "scoped" : "legacy",
            },
          )
        : undefined;
    try {
      const result = await runtime.withSession(input.threadId, async () => {
        assertV2CallerCurrent();
        const current = await Effect.runPromise(
          runtime.options.journal.find(runtimeAdmissionIdentity(input)),
        );
        assertV2CallerCurrent();
        if (!current || current.state === "reserved") {
          session.backgroundClosure?.assertCurrent();
          session.consentPermit?.assertCurrent();
          const hold = session.activation?.token
            ? await settleV2RuntimeReservation(runtime, session)
            : undefined;
          if (session.activation?.token) {
            if (hold) logV2SettlementHold(runtime, session, hold);
            throw new Error(
              `V2 prior physical admission remains owned${hold ? ` (hold: ${hold})` : ""}; no new turn.`,
            );
          }
        }
        if ((!current || current.state === "reserved") && ready) {
          const token = ready.gate.tryReserve(
            ready.stamp,
            JSON.stringify([
              "turn",
              session.storageIdentity,
              session.native.id,
              runtimeAdmissionIdentity(input),
            ]),
          );
          if (!token) throw new V2PreAdmissionRetry();
          session.activation = { ...ready, token, phase: "turn" };
        }
        return withV2AdmissionOperation(session, async () => {
          const owner = captureV2AdmissionOwner(runtime, session);
          const validate = () => {
            assertV2CallerCurrent();
            owner();
          };
          runtime.mutations.assertSafe();
          await guard();
          runtime.mutations.assertSafe();
          const identity = runtimeAdmissionIdentity(input);
          const existing = await Effect.runPromise(runtime.options.journal.find(identity));
          validate();
          const active = await v2Request("session.active", (signal) =>
            session.lease.process.client.session.active({ signal }),
          );
          validate();
          const preparing = !existing || existing.state === "reserved";
          if (preparing && active[session.native.id])
            throw new Error("V2 native execution is already active; no queued duplicate work.");
          if (
            session.row &&
            !session.terminalDelivered &&
            session.row.requestMessageId !== identity.requestMessageId &&
            !(
              !existing &&
              identity.namespace === "foreground" &&
              (await supersedeV2ReservedAdmission(runtime, session, validate))
            )
          )
            throw new Error(
              "V2 previous admission is unresolved; new work may duplicate execution.",
            );
          if (preparing) await runtime.options.threadBridge?.ensure(session);
          validate();
          const prepared = await prepareV2TurnAttachments(
            runtime.options,
            session,
            input,
            Boolean(existing),
          );
          validate();
          if (!existing) await switchV2TurnModel(runtime, session, input);
          validate();
          if (preparing) {
            session.messages.clear();
            session.terminalDelivered = false;
          }
          try {
            const admitted = await dispatchV2Turn(
              runtime.options,
              session,
              input,
              runtime.mutations,
              guard,
              validate,
              prepared,
            );
            validate();
            session.row = admitted;
            if (session.activation?.token && admitted.state !== "terminal")
              session.activation.gate.nativeRunning(session.activation.token);
          } catch (error) {
            const uncertain = await Effect.runPromise(runtime.options.journal.find(identity));
            validate();
            session.row = uncertain;
            if (session.row)
              await v2RuntimeStatus(
                runtime,
                session,
                "error",
                session.row.state === "reserved"
                  ? "Preparation failed before prompt dispatch. Retry the same request after resolving preparation."
                  : "Admission unconfirmed. No automatic resend; new work may duplicate execution.",
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
            payload: {
              model: session.model.id,
              modelSelection: {
                provider: "opencodeV2",
                model: session.model.id,
                subProviderID: session.model.providerID,
              },
            },
          });
          await runtime.reconcile(session);
          return {
            threadId: input.threadId,
            turnId: session.row.turnId,
            resumeCursor: v2ResumeCursor(session),
          };
        });
      });
      await settleV2RuntimeReservation(runtime, session);
      return result;
    } catch (error) {
      if (session.activation?.token) {
        if (session.activation.gate.cancelUndispatched(session.activation.token)) {
          session.activation.token = undefined;
          session.activation.phase = "settled";
        } else session.activation.phase = "uncertain";
      }
      if (!(error instanceof V2PreAdmissionRetry) || retry === 2) throw error;
    }
  }
  throw new V2PreAdmissionRetry();
}
